import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * VER QUIEN REACCIONO NO PUEDE COSTAR PERDER LA PUBLICACION.
 *
 * EL FALLO. Pulsar el número de reacciones hacía
 * `router.push('/reacciones/{id}')`. Como esa ruta NO es una sección,
 * `SwipeTabs` la pinta a pantalla completa por encima del carrusel, y con ella
 * desaparece la barra de navegación. Para una lista de nombres eso es un salto
 * demasiado grande: se pierde de vista la publicación y volver cuesta un gesto.
 *
 * LO QUE SE HIZO. La interacción normal abre una HOJA sobre la publicación. La
 * ruta dedicada SE CONSERVA, porque es la entrada directa: un aviso agrupado
 * —«Edson y 99 personas más»— o un enlace no tienen ninguna publicación abierta
 * detrás sobre la que levantar una hoja.
 *
 * Las dos comparten `ListaDeReacciones`, así que la consulta y el estado se
 * escriben una sola vez.
 *
 * Se mira el CÓDIGO FUENTE, como el resto de pruebas de esta carpeta: montar la
 * vista pediría un renderizador de React Native que este proyecto no tiene en
 * las pruebas, y lo que hay que impedir no es un valor mal calculado sino que
 * alguien vuelva a mandar el feed a una pantalla completa.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const POST_CARD = fuente('components/PostCard.tsx');
const SHEET = fuente('components/ReaccionesSheet.tsx');
const PANTALLA = fuente('screens/ReaccionesScreen.tsx');
const HOJA_BASE = fuente('components/BottomSheet.tsx');

// ---------------------------------------------------------------------------
// 1. Desde el feed: hoja, no pantalla
// ---------------------------------------------------------------------------

test('el numero de reacciones ya no navega a otra pantalla', () => {
  assert.ok(
    !/router\.push\(`\/reacciones\//.test(POST_CARD),
    'PostCard vuelve a mandar a `/reacciones/{id}`: eso es una pantalla ' +
      'completa y se lleva por delante la barra de navegacion.',
  );
});

test('el numero abre la hoja', () => {
  assert.match(POST_CARD, /setReaccionesAbiertas\(true\)/);
  assert.match(POST_CARD, /<ReaccionesSheet/);
  assert.match(POST_CARD, /postId=\{post\.id\}/);
});

// ---------------------------------------------------------------------------
// 2. La ruta dedicada sigue en pie
// ---------------------------------------------------------------------------

test('la pantalla de reacciones no se borro', () => {
  // Es la entrada de los avisos agrupados y de los enlaces directos.
  assert.match(PANTALLA, /export function ReaccionesScreen/);
  assert.match(PANTALLA, /<AppHeader/, 'como pantalla necesita su cabecera');
  assert.match(PANTALLA, /router\.canGoBack\(\)/, 'y su forma de volver');
});

test('pantalla y hoja comparten el mismo contenido', () => {
  /*
    Si cada una montara su propia consulta, arreglar algo en una dejaria la otra
    con el fallo. La lista, el estado de carga y el seguir/dejar de seguir viven
    en un unico sitio.
  */
  assert.match(PANTALLA, /ListaDeReacciones/);
  assert.match(SHEET, /ListaDeReacciones/);

  const compartido = fuente('components/ListaDeReacciones.tsx');
  assert.match(compartido, /PostRepository\.listLikes/);
  assert.match(compartido, /useListaDePersonas/);
  assert.match(compartido, /PeopleList/);

  // Y no quedan copias sueltas de la consulta.
  assert.ok(
    !/listLikes/.test(PANTALLA) && !/listLikes/.test(SHEET),
    'la consulta tiene que estar solo en ListaDeReacciones',
  );
});

// ---------------------------------------------------------------------------
// 3. Sin librerias nuevas, y sin romper la virtualizacion
// ---------------------------------------------------------------------------

test('se reutiliza el BottomSheet del proyecto', () => {
  assert.match(SHEET, /from '@\/components\/BottomSheet'/);
  // Nada de @gorhom u otra hoja de terceros.
  assert.ok(
    !/gorhom|react-native-bottom-sheet|actionsheet/i.test(SHEET),
    'no se anade otra libreria de hojas',
  );
});

test('la lista virtualizada no queda dentro de un ScrollView', () => {
  /*
    `PeopleList` es un `FlashList`. Anidarlo en el `ScrollView` de la hoja le
    quita la altura con la que decide que filas existen: se renderizarian todas
    y se perderia el reciclado.
  */
  assert.match(SHEET, /desplazable=\{false\}/);
  assert.match(HOJA_BASE, /desplazable\?: boolean/, 'la hoja tiene que admitirlo');
  assert.match(HOJA_BASE, /desplazable = true/, 'y seguir desplazando por defecto');
});

test('la hoja tiene alto propio, que es lo que el FlashList necesita', () => {
  // Con alto automatico mediria cero y no pintaria ninguna fila.
  assert.match(SHEET, /useWindowDimensions/);
  assert.match(SHEET, /height: height \* PARTE_DE_LA_PANTALLA/);
});

test('no se pide la lista mientras la hoja esta cerrada', () => {
  /*
    Cada tarjeta del muro monta este componente. Sin la guarda, abrir el feed
    dispararia una peticion de reacciones por publicacion visible.
  */
  assert.match(SHEET, /visible \? <ListaDeReacciones/);
});

// ---------------------------------------------------------------------------
// 4. Accesibilidad y cierre
// ---------------------------------------------------------------------------

test('el numero sigue anunciandose y sin lista no se abre', () => {
  /*
    El marcado se movio a `AccionDePublicacion` al añadir los nombres bajo los
    botones, pero las dos garantias siguen siendo las mismas: el numero se
    anuncia como lo que hace, y sin reacciones no lleva a ninguna parte.
  */
  assert.match(POST_CARD, /etiquetaDelContador=\{t\('post\.whoReacted'\)\}/);

  const accion = fuente('components/AccionDePublicacion.tsx');
  assert.match(
    accion,
    /alPulsarContador && contador > 0/,
    'con el contador a cero el numero no puede seguir siendo pulsable: abriria ' +
      'una lista vacia',
  );
});

test('el cierre lo resuelve la hoja compartida', () => {
  // Atras de Android y tocar fuera ya los trae el Modal del BottomSheet: la
  // hoja de reacciones no tiene que reinventarlos.
  assert.match(HOJA_BASE, /onRequestClose=\{onClose\}/);
  assert.match(HOJA_BASE, /accessibilityLabel="Cerrar panel"/);
  assert.match(SHEET, /onClose=\{onClose\}/);
});
