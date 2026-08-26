import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * La regla dura del carrusel de secciones, comprobada sobre el CODIGO.
 *
 * El carrusel (`SwipeTabs.tsx`) escucha el arrastre horizontal desde un ancestro
 * comun a todas las pestanas, y cuando su gesto se activa CANCELA el de lo que
 * hubiera debajo. Por eso todo lo que ya usa el arrastre horizontal para otra
 * cosa —un carrusel de tarjetas, una fila de filtros, la barra de avance de un
 * reproductor— tiene que declararse con `SinCambioDeSeccion`. Sin eso el gesto
 * se lo lleva la pantalla entera y la fila deja de moverse.
 *
 * Se mira el codigo y no la pantalla por lo mismo que en
 * `components/cuadriculaSinReproductores.test.mts`: montar la vista pediria un
 * renderizador de React Native que este proyecto no tiene en las pruebas, y lo
 * que hay que impedir no es un valor mal calculado sino que alguien vuelva a
 * anadir un arrastre horizontal sin blindarlo.
 *
 * El fallo que fija: la barra de avance del AUDIO era un `PanResponder`
 * horizontal sin blindar, en las tres pantallas donde aparece (el reproductor
 * del muro, el de la lista de podcast y el de `(tabs)/audio/[id]`). Su gemela
 * de video si estaba blindada desde el primer dia; a esta se le paso.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function ficherosDeCodigo(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) ficherosDeCodigo(ruta, encontrados);
    else if (/\.tsx?$/.test(entrada.name) && !entrada.name.endsWith('.d.ts')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

/** Ruta relativa a `src`, que es como se leen los avisos. */
function relativa(ruta: string): string {
  return ruta.slice(SRC.length + 1).replace(/\\/g, '/');
}

/** El fichero declara la zona blindada. */
function estaBlindado(texto: string): boolean {
  return texto.includes('SinCambioDeSeccion');
}

/**
 * Quien puede tener arrastre horizontal SIN blindar, y por que.
 *
 * La lista es corta a proposito: cada entrada es una excepcion razonada, no un
 * permiso general. Si algo nuevo aparece aqui sin motivo, el motivo es que
 * falta el blindaje.
 */
const EXENTOS = new Map<string, string>([
  [
    'navigation/SwipeTabs.tsx',
    'Es el propio carrusel de secciones: es el gesto del que los demas se blindan.',
  ],
  [
    'navigation/tabSwipe.tsx',
    'Es donde vive `SinCambioDeSeccion`; nombrarlo no es usarlo.',
  ],
  [
    'screens/ChatScreen.tsx',
    'La conversacion es una ruta del Stack raiz (`app/chat/[id].tsx`), fuera del grupo de pestanas: no hay carrusel por encima del que blindarse.',
  ],
  [
    'components/ImageViewer.tsx',
    'Vive dentro de un `Modal`, que se monta en OTRA jerarquia nativa: el gesto del carrusel no llega a su contenido y por eso lleva su propio `GestureHandlerRootView`.',
  ],
  [
    'screens/CrearScreen.tsx',
    'Declara su PROPIO arrastre horizontal y le anade `.blocksExternalGesture(gestoDeSeccion)`, que es la otra forma valida de ganarle la mano al carrusel.',
  ],
]);

// ---------------------------------------------------------------------------
// 1. Listas que se desplazan en horizontal
// ---------------------------------------------------------------------------

test('toda lista horizontal dentro de las pestanas esta blindada', () => {
  const culpables: string[] = [];

  for (const ruta of ficherosDeCodigo(SRC)) {
    if (ruta.endsWith('.test.mts')) continue;
    const texto = readFileSync(ruta, 'utf8');
    /*
      La prop booleana `horizontal` de un ScrollView / FlatList / FlashList,
      sola en su linea o con valor explicito. No vale buscar la palabra suelta:
      `paddingHorizontal` y `more-horizontal` la llevan dentro.
    */
    const esHorizontal = /^\s*horizontal(\s*=\s*\{true\})?\s*$/m.test(texto);
    if (!esHorizontal) continue;
    if (estaBlindado(texto)) continue;
    if (EXENTOS.has(relativa(ruta))) continue;
    culpables.push(relativa(ruta));
  }

  assert.deepEqual(
    culpables,
    [],
    'Estas listas se desplazan en horizontal sin blindarse: el carrusel de secciones les robara el gesto. ' +
      'Envuelvelas en <SinCambioDeSeccion>.',
  );
});

// ---------------------------------------------------------------------------
// 2. Barras que se arrastran con el dedo (PanResponder)
// ---------------------------------------------------------------------------

test('toda barra arrastrable esta blindada, y desde el primer contacto', () => {
  const culpables: string[] = [];
  const sinActivarAlTocar: string[] = [];

  for (const ruta of ficherosDeCodigo(SRC)) {
    if (ruta.endsWith('.test.mts')) continue;
    const texto = readFileSync(ruta, 'utf8');
    if (!texto.includes('PanResponder.create')) continue;
    if (EXENTOS.has(relativa(ruta))) continue;

    if (!estaBlindado(texto)) {
      culpables.push(relativa(ruta));
      continue;
    }
    /*
      Una barra NO es un ScrollView: no hay ningun desplazamiento nativo que
      "empiece a moverse" y al que el blindaje pueda asomarse. Sin
      `activarAlTocar` el gesto se reserva tarde y el carrusel llega antes.
    */
    if (!/SinCambioDeSeccion\s+activarAlTocar/.test(texto)) {
      sinActivarAlTocar.push(relativa(ruta));
    }
  }

  assert.deepEqual(
    culpables,
    [],
    'Estas barras se arrastran con el dedo sin blindarse: arrastrarlas cambiara de seccion. ' +
      'Envuelvelas en <SinCambioDeSeccion activarAlTocar>.',
  );
  assert.deepEqual(
    sinActivarAlTocar,
    [],
    'A estas barras les falta `activarAlTocar`: sin el, el blindaje reserva el gesto demasiado tarde.',
  );
});
