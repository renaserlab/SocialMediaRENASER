import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const APP = join(RAIZ, 'app');
const SRC = join(RAIZ, 'src');

const fuente = (...partes: string[]) => readFileSync(join(...partes), 'utf8');

/**
 * NINGUNA PORTADA DE VERTICAL PUEDE SER UNA HABITACIÓN SIN PUERTA.
 *
 * EL FALLO QUE ESTO CIERRA. Los cuatro accesos de Explorar empujan a rutas que
 * viven FUERA de `app/(tabs)/`. Eso quita la barra inferior —a propósito: son
 * pantallas completas—, y entonces el encabezado se queda como ÚNICO camino de
 * vuelta. `CursosScreen` no lo ofrecía en ninguno de sus tres estados, así que
 * quien entraba desde Explorar se quedaba encerrado: ni atrás, ni pestañas. En
 * el estado de error era todavía peor, porque además no había nada que mirar.
 *
 * POR QUÉ LA LISTA NO ESTÁ ESCRITA AQUÍ. Se lee de `AccesosAVerticales.tsx`, de
 * la misma constante que usa la pantalla. Una lista copiada a mano se queda
 * vieja el día que se añade la quinta vertical —que es exactamente el día en
 * que esta prueba tiene que ponerse roja— y entonces habría dos verdades: la
 * que navega y la que se comprueba.
 *
 * ES UNA PRUEBA DE TEXTO, un cerrojo, como las de garantía o las de la portada
 * de Cursos: aquí no hay renderizador. No afirma que el botón se pinte, afirma
 * que a cada `AppHeader` se le pasa el `onBack` sin el cual no se pinta.
 */

const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINEA = new RegExp('//[^\\n]*', 'g');

/** El código sin comentarios: aquí se habla de lo que el código NO hace. */
function sinComentarios(codigo: string): string {
  return codigo.replace(BLOQUE, ' ').replace(LINEA, ' ');
}

// ---------------------------------------------------------------------------
// De los accesos de Explorar a la pantalla que los atiende
// ---------------------------------------------------------------------------

const ACCESOS = fuente(SRC, 'components', 'AccesosAVerticales.tsx');

/**
 * Las rutas declaradas en la constante `VERTICALES`, y solo ahí.
 *
 * Se recorta el bloque del array antes de buscar porque el TIPO `Vertical`
 * nombra las mismas rutas para que expo-router las compruebe; buscando sobre el
 * fichero entero, la prueba leería la unión de tipos en vez de la lista real.
 */
function rutasDeLasVerticales(): string[] {
  const inicio = ACCESOS.indexOf('const VERTICALES');
  assert.notEqual(
    inicio,
    -1,
    'no se encuentra `VERTICALES` en AccesosAVerticales.tsx: si se ha renombrado, ' +
      'esta prueba hay que reapuntarla, no borrarla.',
  );
  const fin = ACCESOS.indexOf('];', inicio);
  const bloque = ACCESOS.slice(inicio, fin);
  return [...bloque.matchAll(/ruta:\s*'([^']+)'/g)].map((casa) => casa[1]);
}

/** Los ficheros de `app/` que pueden atender una ruta, con y sin `(tabs)`. */
function candidatosDeRuta(ruta: string): string[] {
  const segmentos = ruta.split('/').filter(Boolean);
  if (segmentos.length === 0) return [join(APP, 'index.tsx')];
  return [
    join(APP, ...segmentos) + '.tsx',
    join(APP, ...segmentos, 'index.tsx'),
    join(APP, '(tabs)', ...segmentos) + '.tsx',
    join(APP, '(tabs)', ...segmentos, 'index.tsx'),
  ];
}

/** El fichero de `app/` que atiende la ruta, o `null` si no hay ninguno. */
function ficheroDeRuta(ruta: string): string | null {
  return candidatosDeRuta(ruta).find((c) => existsSync(c)) ?? null;
}

/**
 * La pantalla de `src/screens/` que exporta ese fichero de ruta.
 *
 * Cada fichero de `app/` es una línea: importa una pantalla y la reexporta. Se
 * sigue ese hilo en vez de adivinar el nombre por la ruta, que es como se
 * acaba comprobando un fichero que ya no es el que se pinta.
 */
function pantallaDeRuta(ruta: string): { nombre: string; codigo: string } {
  const fichero = ficheroDeRuta(ruta);
  assert.ok(fichero, `la vertical apunta a «${ruta}» y no hay ninguna pantalla ahí.`);
  const casa = fuente(fichero).match(/from '@\/screens\/([A-Za-z0-9/]+)'/);
  assert.ok(casa, `${ruta} no reexporta ninguna pantalla de «@/screens».`);
  const ruta2 = join(SRC, 'screens', ...casa[1].split('/')) + '.tsx';
  assert.ok(existsSync(ruta2), `${ruta} importa una pantalla que no existe: ${casa[1]}`);
  return { nombre: casa[1], codigo: fuente(ruta2) };
}

// ---------------------------------------------------------------------------
// Leer las etiquetas <AppHeader ... > de un fichero
// ---------------------------------------------------------------------------

/**
 * Las etiquetas de apertura de cada `<AppHeader>`, enteras.
 *
 * Se recorre a mano en vez de con una expresión regular porque las props
 * llevan llaves con funciones dentro —`onBack={() => ...}`— y el `>` de la
 * flecha no cierra la etiqueta. Se cuenta la profundidad de llaves: solo el
 * `>` o el `/>` que se encuentra a profundidad cero termina la apertura.
 */
function etiquetasDeAppHeader(codigo: string): string[] {
  const limpio = sinComentarios(codigo);
  const etiquetas: string[] = [];
  let desde = 0;
  for (;;) {
    const inicio = limpio.indexOf('<AppHeader', desde);
    if (inicio === -1) break;
    // `<AppHeaderAlgo` no es `<AppHeader`.
    const siguiente = limpio[inicio + '<AppHeader'.length];
    if (siguiente !== undefined && /[A-Za-z0-9_]/.test(siguiente)) {
      desde = inicio + 1;
      continue;
    }
    let profundidad = 0;
    let i = inicio;
    for (; i < limpio.length; i += 1) {
      const c = limpio[i];
      if (c === '{') profundidad += 1;
      else if (c === '}') profundidad -= 1;
      else if (profundidad === 0 && c === '/' && limpio[i + 1] === '>') {
        i += 1;
        break;
      } else if (profundidad === 0 && c === '>' && limpio[i - 1] !== '=') break;
    }
    etiquetas.push(limpio.slice(inicio, i + 1));
    desde = i + 1;
  }
  return etiquetas;
}

// ---------------------------------------------------------------------------
// 1. Cada portada de vertical ofrece «Atrás» en TODOS sus encabezados
// ---------------------------------------------------------------------------

describe('las portadas de las verticales tienen salida', () => {
  const rutas = rutasDeLasVerticales();

  it('hay verticales que comprobar (si no, la prueba no vigila nada)', () => {
    assert.ok(
      rutas.length > 0,
      'ninguna vertical con ruta: o se han apagado todas, o `VERTICALES` cambió de forma ' +
        'y esta prueba dejó de leerla. Las dos cosas hay que mirarlas a mano.',
    );
  });

  for (const ruta of rutas) {
    it(`«${ruta}» está fuera de (tabs), así que su encabezado es la única salida`, () => {
      const fichero = ficheroDeRuta(ruta);
      assert.ok(fichero, `no hay pantalla para «${ruta}».`);
      /*
        Esto no pide que la vertical esté fuera de las pestañas: comprueba de
        DÓNDE viene la obligación. Si algún día una vertical se metiera dentro
        de `(tabs)` tendría barra inferior y el «Atrás» dejaría de ser el único
        camino; entonces esta prueba tendría que revisarse, no seguir en verde
        por casualidad.
      */
      assert.ok(
        !fichero.includes(join('app', '(tabs)')),
        `«${ruta}» vive dentro de (tabs): revisa si sigue teniendo sentido exigirle «Atrás».`,
      );
    });

    it(`«${ruta}» pasa onBack a TODOS sus AppHeader, incluidos carga y error`, () => {
      const { nombre, codigo } = pantallaDeRuta(ruta);
      const etiquetas = etiquetasDeAppHeader(codigo);
      assert.ok(
        etiquetas.length > 0,
        `${nombre} no pinta ningún AppHeader: sin encabezado no hay «Atrás» posible.`,
      );
      etiquetas.forEach((etiqueta, indice) => {
        assert.ok(
          /\bonBack\b/.test(etiqueta) || /\bback\b/.test(etiqueta),
          `${nombre}: el AppHeader nº ${indice + 1} no recibe «onBack».\n` +
            `Sin él no se pinta el botón y la pantalla queda sin salida, porque ` +
            `«${ruta}» no tiene barra inferior. Los estados de CARGA y de ERROR ` +
            `cuentan: quedarse encerrado en el error es todavía peor.\n` +
            `Etiqueta: ${etiqueta.replace(/\s+/g, ' ').slice(0, 120)}`,
        );
      });
    });

    it(`el respaldo de «${ruta}» lleva a una ruta que existe`, () => {
      const { nombre, codigo } = pantallaDeRuta(ruta);
      /*
        `router.back()` no hace nada cuando no hay historial —un enlace directo,
        o recargar en el navegador—, y por eso el patrón lleva un `replace` de
        respaldo. Si ese destino no existiera, la salida llevaría a la pantalla
        de ruta desconocida: cambiar la cerradura por otra cerradura.
      */
      const destinos = [...sinComentarios(codigo).matchAll(/router\.replace\('([^']+)'/g)].map(
        (casa) => casa[1],
      );
      assert.ok(destinos.length > 0, `${nombre} no declara ningún respaldo para el «Atrás».`);
      for (const destino of destinos) {
        assert.ok(
          ficheroDeRuta(destino),
          `${nombre} cae en «${destino}» cuando no hay historial, y esa ruta no existe en app/.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Y lo mismo para lo demás que se alcanza desde Explorar
// ---------------------------------------------------------------------------

/**
 * Las rutas ESCRITAS TAL CUAL a las que empuja Explorar.
 *
 * Solo los literales: los destinos con plantilla —`/circle/${id}`— llevan a
 * fichas que ya se cubren en otro sitio, y resolverlas aquí obligaría a
 * interpretar expresiones. Lo que se vigila es lo que Explorar abre de golpe.
 */
function rutasLiteralesDeExplorar(): string[] {
  const codigo = sinComentarios(fuente(SRC, 'screens', 'ExploreScreen.tsx'));
  const encontradas = [...codigo.matchAll(/router\.(?:push|replace)\('(\/[^'${}]*)'/g)].map(
    (casa) => casa[1],
  );
  return [...new Set(encontradas)];
}

describe('lo que Explorar abre a pantalla completa también tiene salida', () => {
  for (const ruta of rutasLiteralesDeExplorar()) {
    const fichero = ficheroDeRuta(ruta);
    // Lo que vive dentro de `(tabs)` conserva la barra inferior: ahí el
    // «Atrás» del encabezado no es la única salida y no se exige.
    if (!fichero || fichero.includes(join('app', '(tabs)'))) continue;

    it(`«${ruta}» pasa onBack a todos sus AppHeader`, () => {
      const { nombre, codigo } = pantallaDeRuta(ruta);
      for (const [indice, etiqueta] of etiquetasDeAppHeader(codigo).entries()) {
        assert.ok(
          /\bonBack\b/.test(etiqueta) || /\bback\b/.test(etiqueta),
          `${nombre}: el AppHeader nº ${indice + 1} no recibe «onBack», y «${ruta}» ` +
            'se abre desde Explorar sin barra inferior.',
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. La biblioteca, que se abre DESDE la portada de Cursos
// ---------------------------------------------------------------------------

describe('la biblioteca, que cuelga de la portada de Cursos', () => {
  /*
    `/library` estaba igual de encerrada y por el mismo motivo: se llega desde
    el icono del encabezado de `/cursos`, vive fuera de `(tabs)` y su único
    `AppHeader` no llevaba «Atrás». Arreglar la portada y dejar esto habría sido
    mover la puerta tapiada un paso más adentro.
  */
  it('la portada de Cursos sigue siendo quien la abre', () => {
    const portada = sinComentarios(fuente(SRC, 'screens', 'CursosScreen.tsx'));
    assert.match(
      portada,
      /router\.push\('\/library'/,
      'si la biblioteca ya no se abre desde aquí, este bloque describe un camino que no existe.',
    );
  });

  it('y ofrece «Atrás» en su encabezado', () => {
    const codigo = fuente(SRC, 'screens', 'LibraryScreen.tsx');
    const etiquetas = etiquetasDeAppHeader(codigo);
    assert.ok(etiquetas.length > 0, 'LibraryScreen no pinta ningún AppHeader.');
    for (const etiqueta of etiquetas) {
      assert.ok(
        /\bonBack\b/.test(etiqueta) || /\bback\b/.test(etiqueta),
        'LibraryScreen sin «Atrás»: fuera de (tabs) no hay ninguna otra salida.',
      );
    }
  });
});
