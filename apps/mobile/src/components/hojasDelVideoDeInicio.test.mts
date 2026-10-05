import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EL VIDEO DE INICIO ABRE LAS MISMAS HOJAS QUE LA TARJETA DE EXPLORAR.
 *
 * LO QUE SE REPORTO (26/09):
 *
 *   1. En Inicio, el boton de comentar llevaba a OTRA pantalla
 *      (`/comments/{id}`, a pantalla completa y en blanco). Tenia que subir la
 *      misma bandeja que en Explorar, con el video detras.
 *   2. En Inicio no habia forma de ver quien reacciono. En Explorar el numero
 *      de «me gusta» abre esa lista, con seguir y con ir al perfil.
 *   3. Es la misma publicacion en los dos sitios: lo que se comenta en uno
 *      tiene que verse en el otro, en todos los videos.
 *
 * Lo tercero se cumple porque las dos superficies piden los comentarios por el
 * id de la publicacion, y el id del video ES ese id. El numero de comentarios
 * se comparte por el almacen (`commentCounts`), igual que ya se hacia con el de
 * reacciones (`likeCounts`).
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta: montar la
 * vista pediria un renderizador de React Native que este proyecto no tiene en
 * las pruebas.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/** Quita los comentarios: lo que se busca tiene que estar en el codigo. */
function sinComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const CELDA = sinComentarios(fuente('components/ShortVideoItem.tsx'));
const FEED = sinComentarios(fuente('components/FeedVerticalDeVideos.tsx'));
const HOJA_DE_COMENTARIOS = sinComentarios(fuente('components/CommentsSheet.tsx'));
const HOOK = sinComentarios(fuente('hooks/useComentarios.ts'));
const STORE = sinComentarios(fuente('store/useAppStore.ts'));
const FUENTE_DE_VIDEOS = sinComentarios(fuente('feed/fuenteDeVideos.ts'));

// ---------------------------------------------------------------------------
// 1. Comentar: hoja, no pantalla
// ---------------------------------------------------------------------------

test('el video de Inicio ya no manda a la pantalla de comentarios', () => {
  assert.doesNotMatch(
    CELDA,
    /\/comments\//,
    'ShortVideoItem vuelve a navegar a `/comments/{id}`: es una pantalla ' +
      'completa y se pierde el video de vista.',
  );
});

test('el boton de comentar abre la hoja del feed', () => {
  assert.match(CELDA, /onPress=\{\(\) => alAbrirComentarios\(short\.id, comentarios\)\}/);
  assert.match(FEED, /alAbrirComentarios=\{abrirComentarios\}/);
});

test('es la MISMA hoja de comentarios que en Explorar', () => {
  // Si alguien escribiera una segunda hoja para Inicio, lo que se arreglara en
  // una seguiria roto en la otra.
  assert.match(FEED, /import \{ CommentsSheet \} from '@\/components\/CommentsSheet'/);
  assert.match(FEED, /<CommentsSheet/);
  assert.match(FEED, /postId=\{comentandoEn\?\.postId \?\? null\}/);
});

// ---------------------------------------------------------------------------
// 2. Quien reacciono: el numero abre la lista, el corazon sigue reaccionando
// ---------------------------------------------------------------------------

test('es la MISMA hoja de reacciones que en Explorar', () => {
  assert.match(FEED, /import \{ ReaccionesSheet \} from '@\/components\/ReaccionesSheet'/);
  assert.match(FEED, /<ReaccionesSheet/);
  assert.match(FEED, /postId=\{reaccionesDe\}/);
  assert.match(FEED, /alVerReacciones=\{verReacciones\}/);
});

test('el corazon y el numero son dos botones distintos', () => {
  // El corazon sigue dando «me gusta»...
  assert.match(CELDA, /onPress=\{toggleLike\}/);
  // ...y el numero abre la lista.
  assert.match(CELDA, /onPress=\{\(\) => alVerReacciones\(short\.id\)\}/);
  const corazon = CELDA.indexOf('onPress={toggleLike}');
  const numero = CELDA.indexOf('alVerReacciones(short.id)');
  // El corazon es un `Pulsable` (se hunde y salta); el numero, su propio pulsable.
  const cierreDelCorazon = CELDA.indexOf('</Pulsable>', corazon);
  assert.ok(
    cierreDelCorazon > 0 && cierreDelCorazon < numero,
    'El numero esta dentro del boton del corazon: tocarlo daria «me gusta» ' +
      'en vez de abrir la lista.',
  );
});

test('sin reacciones el numero no es pulsable', () => {
  // Igual que en Explorar (`AccionDePublicacion`): no hay lista que ensenar.
  assert.match(CELDA, /\{likes > 0 \? \(\s*<Pressable\s+onPress=\{\(\) => alVerReacciones/);
});

test('las zonas de toque del corazon y del numero no se pisan', () => {
  const celda = fuente('components/ShortVideoItem.tsx');
  assert.match(celda, /AREA_DEL_CORAZON = \{[^}]*bottom: 0[^}]*\}/);
  assert.match(celda, /AREA_DEL_NUMERO = \{[^}]*top: 0[^}]*\}/);
});

// ---------------------------------------------------------------------------
// 3. Las hojas viven en el feed, no en cada celda
// ---------------------------------------------------------------------------

test('la celda no guarda estado de hojas', () => {
  // FlashList recicla las celdas: un `useState` aqui acabaria en otro video.
  assert.doesNotMatch(CELDA, /<CommentsSheet|<ReaccionesSheet/);
  assert.doesNotMatch(CELDA, /useState/);
});

test('las funciones que viajan a las celdas son estables', () => {
  // Las celdas estan memoizadas para no redibujarse al deslizar; una funcion
  // nueva en cada render las redibujaria todas.
  for (const nombre of ['abrirComentarios', 'verReacciones']) {
    const desde = FEED.indexOf(`const ${nombre} = useCallback(`);
    assert.ok(desde >= 0, `falta ${nombre}`);
    // Solo SU llamada: hasta el `);` que la cierra, sin saltar a la siguiente.
    const llamada = FEED.slice(desde, FEED.indexOf(');', desde) + 2);
    assert.match(llamada, /,\s*\[\],?\s*\);$/, `${nombre} no es estable`);
  }
});

// ---------------------------------------------------------------------------
// 4. Misma publicacion, mismos comentarios y mismo numero
// ---------------------------------------------------------------------------

test('el id del video es el de la publicacion', () => {
  // Es lo que hace que las dos hojas pidan los mismos comentarios.
  assert.match(FUENTE_DE_VIDEOS, /id: post\.id,/);
});

test('el numero de comentarios del video sale del almacen compartido', () => {
  assert.match(CELDA, /state\.commentCounts\[short\.id\]/);
  assert.match(CELDA, /Math\.max\(comentariosAnotados \?\? 0, short\.comments\)/);
  assert.match(CELDA, /<ContadorAnimado valor=\{comentarios\}/);
  assert.doesNotMatch(CELDA, /valor=\{short\.comments\}|\{short\.comments\}<\/Text>/);
});

test('comentar anota el total para las demas superficies', () => {
  assert.match(HOOK, /anotarComentarios\(postId, total\)/);
  assert.match(HOOK, /sumarAlContadorDelMuro\(resultado\.delta, resultado\.estado\.total\)/);
  // El muro de Explorar se sigue actualizando como antes.
  assert.match(HOOK, /commentsCount: \(post\.commentsCount \?\? post\.comments\.length\) \+ delta/);
});

test('la hoja usa el numero que ensena el video si la publicacion no esta en el muro', () => {
  // Sin esto, el titulo contaria solo la primera pagina: «20» con 35.
  assert.match(HOOK, /useComentarios\(postId: string \| undefined \| null, totalConocido\?: number\)/);
  // Sin `totalConocido` (Explorar) se usa el del muro, exactamente como antes.
  assert.match(
    HOOK,
    /totalConocido === undefined \? enElMuro : Math\.max\(enElMuro \?\? 0, totalConocido\)/,
  );
  assert.match(HOJA_DE_COMENTARIOS, /useComentarios\(postId, totalConocido\)/);
  assert.match(FEED, /totalConocido=\{comentandoEn\?\.total\}/);
});

test('el contador de comentarios no se guarda en disco', () => {
  assert.match(STORE, /commentCounts: Record<string, number>/);
  const persistidos = STORE.slice(STORE.indexOf('partialize:'));
  assert.doesNotMatch(
    persistidos.slice(0, persistidos.indexOf('onRehydrateStorage')),
    /commentCounts/,
    'commentCounts es una foto del servidor: guardarla ensenaria un numero viejo al abrir.',
  );
});
