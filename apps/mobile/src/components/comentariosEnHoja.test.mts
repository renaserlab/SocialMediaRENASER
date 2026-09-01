import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * COMENTAR NO PUEDE SER UNA SEGUNDA IMPLEMENTACION, PEOR, DE LO MISMO.
 *
 * EL FALLO. Desde una publicacion los comentarios se desplegaban DENTRO de la
 * tarjeta: una lista sin paginar, un campo propio y su propio envio. La
 * pantalla `/comments/{id}` hacia lo mismo, pero bien —con cursor, con estados
 * y con vuelta atras—. Dos codigos para una sola cosa: lo que se arreglaba en
 * uno seguia roto en el otro.
 *
 * LO QUE SE HIZO. Desde el muro sube una HOJA, como la de reacciones, y la
 * publicacion se queda detras. La pantalla SE CONSERVA porque es el destino de
 * los avisos y de los enlaces, que no tienen ninguna publicacion abierta debajo
 * sobre la que levantar una hoja. Las dos montan `useComentarios` y
 * `ContenidoDeComentarios`.
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta: montar la
 * vista pediria un renderizador de React Native que este proyecto no tiene en
 * las pruebas. Lo que hay que impedir no es un valor mal calculado sino que
 * alguien vuelva a escribir la lista por segunda vez, o que la hoja se quede
 * encima del perfil al que lleva.
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

const POST_CARD = sinComentarios(fuente('components/PostCard.tsx'));
const HOJA = sinComentarios(fuente('components/CommentsSheet.tsx'));
const CONTENIDO = sinComentarios(fuente('components/ContenidoDeComentarios.tsx'));
const PANTALLA = sinComentarios(fuente('screens/CommentsScreen.tsx'));
const HOOK = sinComentarios(fuente('hooks/useComentarios.ts'));

// ---------------------------------------------------------------------------
// 1. Desde el feed: hoja, y nada desplegado dentro de la tarjeta
// ---------------------------------------------------------------------------

test('la tarjeta abre la hoja de comentarios', () => {
  assert.match(POST_CARD, /<CommentsSheet/);
  assert.match(POST_CARD, /setComentariosAbiertos\(true\)/);
});

test('la tarjeta ya NO despliega comentarios dentro', () => {
  // Era el sintoma: la lista crecia dentro de la publicacion y empujaba el feed.
  assert.doesNotMatch(POST_CARD, /showComments/);
  assert.doesNotMatch(POST_CARD, /post\.comments\.map/);
});

test('la tarjeta ya no tiene su propio campo de escribir', () => {
  // El campo duplicado es lo que hacia que hubiera dos envios distintos.
  assert.doesNotMatch(POST_CARD, /submitComment/);
  assert.doesNotMatch(POST_CARD, /commentInput/);
});

// ---------------------------------------------------------------------------
// 2. Una sola implementacion para las dos superficies
// ---------------------------------------------------------------------------

test('la hoja y la pantalla montan el mismo contenido', () => {
  for (const [nombre, archivo] of [
    ['hoja', HOJA],
    ['pantalla', PANTALLA],
  ] as const) {
    assert.match(archivo, /<ContenidoDeComentarios/, `${nombre} sin el contenido comun`);
    assert.match(archivo, /useComentarios\(/, `${nombre} sin el hook comun`);
  }
});

test('la pantalla no vuelve a escribir la carga ni el envio', () => {
  // Si reaparecen aqui, es que se ha vuelto a duplicar la logica.
  for (const propia of ['listCommentsPage', 'enviarComentario', 'anadirPagina']) {
    assert.doesNotMatch(PANTALLA, new RegExp(propia), `la pantalla repite ${propia}`);
  }
});

test('la pantalla sigue existiendo para los avisos y los enlaces', () => {
  assert.match(PANTALLA, /useLocalSearchParams/);
  assert.match(PANTALLA, /<AppHeader/);
});

test('la paginacion sigue siendo por cursor, no por offset', () => {
  assert.match(HOOK, /before: estado\.cursor/);
  assert.match(HOOK, /onEndReached|cargarMas/);
});

test('la lista sigue virtualizada', () => {
  // Con la hoja de por medio es facil acabar pintando un `map` dentro de un
  // ScrollView: entonces se renderizan los cien comentarios de golpe.
  assert.match(CONTENIDO, /<FlatList/);
});

test('la hoja apaga el ScrollView de la hoja base', () => {
  // Anidar una lista virtualizada en un ScrollView le quita la altura con la
  // que decide que filas existen: se pierde el reciclado.
  assert.match(HOJA, /desplazable=\{false\}/);
});

// ---------------------------------------------------------------------------
// 3. El hook solo existe con la hoja abierta
// ---------------------------------------------------------------------------

test('no se piden comentarios hasta abrir la hoja', () => {
  // Cada tarjeta del muro monta una hoja. Sin esta guarda, abrir el feed
  // dispararia una peticion de comentarios por publicacion visible.
  assert.match(HOJA, /visible && postId \? <Cuerpo/);
});

// ---------------------------------------------------------------------------
// 4. Navegar desde un comentario
// ---------------------------------------------------------------------------

test('se abre el perfil por ID, nunca por nombre', () => {
  assert.match(CONTENIDO, /onPersonPress\?\.\(\{ id: item\.authorId \}\)/);
  assert.doesNotMatch(CONTENIDO, /irAlPerfil\([^)]*item\.author\b/);
});

test('la hoja CIERRA antes de navegar', () => {
  // El fallo que ya se arreglo en la de reacciones: el Modal se quedaba montado
  // sobre el perfil al que llevaba, y no habia forma de quitarlo.
  // Dentro del propio manejador: `irAlPerfil` tambien aparece arriba, en el
  // import, y buscarlo en el fichero entero daria por buena cualquier cosa.
  const manejador = HOJA.slice(HOJA.indexOf('const alTocarPersona'));
  const cierra = manejador.indexOf('onClose()');
  const navega = manejador.indexOf('irAlPerfil(');
  assert.ok(cierra > 0 && navega > cierra, 'se navega sin cerrar la hoja antes');
});

test('no se espera a ningun temporizador para navegar', () => {
  // Navegar POR DEBAJO de un Modal que se cierra no tiene el problema de
  // presentar algo encima, que es para lo que existe `afterSheetClose`.
  assert.doesNotMatch(HOJA, /setTimeout|afterSheetClose|closeThen/);
});

test('la pantalla navega directa: alli no hay hoja que cerrar', () => {
  assert.match(PANTALLA, /irAlPerfil\(router, persona\.id\)/);
});

// ---------------------------------------------------------------------------
// 5. Responder
// ---------------------------------------------------------------------------

test('el padre viaja al servidor', () => {
  // El movil lo perdia por el camino: `addComment` no lo mandaba.
  assert.match(HOOK, /respondiendo\?\.id \?\? null/);
  assert.match(HOOK, /addComment\(postId, texto, padre\)/);
});

test('se dice a quien se responde y se puede cancelar', () => {
  assert.match(CONTENIDO, /post\.replyingTo/);
  assert.match(CONTENIDO, /setRespondiendo\(null\)/);
});

test('un envio fallido conserva el destino de la respuesta', () => {
  // Si se limpiara siempre, quien reintenta tendria que volver a elegir a quien
  // responde, y lo mas probable es que acabara comentando suelto sin notarlo.
  assert.match(HOOK, /if \(resultado\.delta > 0\) setRespondiendo\(null\)/);
});

// ---------------------------------------------------------------------------
// 6. Reaccionar a un comentario
// ---------------------------------------------------------------------------

test('el contador y el corazon vienen en el comentario, sin pedir por fila', () => {
  const REPO = sinComentarios(fuente('repositories/PostRepository.ts'));
  assert.match(REPO, /likesCount: dto\.likes_count \?\? 0/);
  assert.match(REPO, /viewerReacted: dto\.viewer_reacted \?\? false/);
});

test('un comentario que aun no existe en el servidor no se puede reaccionar', () => {
  // Sin id real, pulsarlo daria un 404.
  assert.match(HOOK, /esOptimista\(comentarioId\)/);
});

test('la reaccion se deshace si el servidor la rechaza', () => {
  const reaccionar = HOOK.slice(HOOK.indexOf('const reaccionar'));
  assert.match(reaccionar, /catch \{[\s\S]*conReaccion\(actual, comentarioId, !activar\)/);
});
