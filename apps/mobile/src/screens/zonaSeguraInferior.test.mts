import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NINGUNA PANTALLA SE PINTA DEBAJO DE LOS BOTONES DE ANDROID.
 *
 * EL FALLO QUE ESTO IMPIDE (25/09/2026, en un telefono con navegacion de tres
 * botones). La aplicacion es `edgeToEdgeEnabled`: en Android se pinta por
 * debajo de los botones del sistema. «Postula tu producto» en Mis productos y
 * «Ver mis pedidos» en la bolsa quedaban debajo de ellos, sin poder pulsarse, y
 * lo mismo el final de cualquier lista. No era un par de pantallas: `AppScreen`
 * —el contenedor de cien— no apartaba el borde de abajo, y otras doce no
 * usaban contenedor ninguno.
 *
 * La regla, que es lo que se comprueba:
 *
 *  - Fuera de las pestañas, `AppScreen` aparta la zona segura por su cuenta, y
 *    las pantallas no la vuelven a sumar (saldria el doble).
 *  - Dentro de las pestañas la aparta la capsula flotante, y cada pantalla le
 *    deja sitio con `useEspacioInferior()` / `espacioParaLaBarra()`.
 *  - Una pantalla que no usa `AppScreen` dice como respeta el borde: zona
 *    segura propia, `insets.bottom`, o un componente que lo hace por ella.
 *
 * Se mira el CODIGO FUENTE, como el resto de pruebas de esta carpeta: montar
 * las vistas pediria un renderizador de React Native que el proyecto no tiene.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const APP = join(SRC, '..', 'app');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sinComentarios(texto: string): string {
  return texto
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Todas las pantallas de `src/screens`, sin pruebas. */
const PANTALLAS = readdirSync(CARPETA)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.replace(/\.tsx$/, ''))
  .sort();

/** Las que se montan dentro del grupo `(tabs)`, debajo de la capsula. */
const EN_PESTANAS = (() => {
  const nombres = new Set<string>();
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(ruta);
      else if (entrada.name.endsWith('.tsx')) {
        for (const m of readFileSync(ruta, 'utf8').matchAll(/from '@\/screens\/(\w+)'/g)) {
          nombres.add(m[1]);
        }
      }
    }
  };
  recorrer(join(APP, '(tabs)'));
  return nombres;
})();

/** Formas de respetar el borde de abajo sin `AppScreen`. */
const RESPETA_POR_SU_CUENTA: RegExp[] = [
  /useEspacioInferior\(\)/,
  /espacioParaLaBarra\(/,
  /insets\.bottom/,
  // `SafeAreaView` sin `edges` respeta los cuatro bordes.
  /<SafeAreaView(?![^>]*\bedges=)[^>]*>/,
  /<SafeAreaView[^>]*\bedges=\{\[[^\]]*'bottom'/,
];

/**
 * Pantallas que no pintan su propio borde inferior: se lo dejan entero a un
 * componente, que es el que tiene que cumplir.
 */
const DELEGAN: Record<string, string[]> = {
  TermsScreen: ['components/LegalDocument.tsx'],
  PrivacyScreen: ['components/LegalDocument.tsx'],
  FollowersScreen: ['components/PeopleList.tsx'],
  FollowingScreen: ['components/PeopleList.tsx'],
  CrearScreen: [
    'components/crear/ModoPublicacion.tsx',
    'components/crear/ModoReel.tsx',
    'components/crear/ModoHistoria.tsx',
    'components/crear/ModoVivo.tsx',
  ],
};

const usaAppScreen = (codigo: string) => /<AppScreen\b/.test(codigo);
const respetaPorSuCuenta = (codigo: string) => RESPETA_POR_SU_CUENTA.some((r) => r.test(codigo));

test('se encuentran las pantallas y las de las pestañas', () => {
  // Si la busqueda se rompe, las pruebas de abajo pasarian sin mirar nada.
  assert.ok(PANTALLAS.length > 100, `solo ${PANTALLAS.length} pantallas en src/screens`);
  for (const nombre of ['InicioScreen', 'ExploreScreen', 'MessagesScreen', 'ProfileScreen']) {
    assert.ok(EN_PESTANAS.has(nombre), `${nombre} deberia estar en (tabs)`);
  }
});

test('AppScreen aparta el borde de abajo fuera de las pestañas, y solo fuera', () => {
  const codigo = sinComentarios(fuente('components/AppScreen.tsx'));
  assert.match(
    codigo,
    /dentroDeLasPestanas \? \['left', 'right'\] : \['left', 'right', 'bottom'\]/,
    'el valor por omision de `edges` volvio a dejar fuera el borde de abajo',
  );
  assert.match(codigo, /useDentroDeLasPestanas\(\)/);
  // Y avisa a lo de dentro de que ya esta apartado.
  assert.match(codigo, /bordes\.includes\('bottom'\) \? <ReservaDeZonaSegura>/);
});

test('useEspacioInferior no vuelve a sumar lo que AppScreen ya aparto', () => {
  const codigo = sinComentarios(fuente('components/espacioInferior.tsx'));
  assert.match(codigo, /const reservada = useContext\(ZonaSeguraReservada\);/);
  assert.match(codigo, /reservada \? Math\.max\(desdeElCanto - insets\.bottom, spacing\.sm\) : desdeElCanto/);
});

test('toda pantalla dice como respeta el borde de abajo', () => {
  const sinDecir: string[] = [];
  for (const nombre of PANTALLAS) {
    const codigo = sinComentarios(fuente(`screens/${nombre}.tsx`));
    if (usaAppScreen(codigo) || respetaPorSuCuenta(codigo)) continue;
    const delegados = DELEGAN[nombre];
    if (delegados) {
      for (const rel of delegados) {
        const suyo = sinComentarios(fuente(rel));
        assert.ok(
          usaAppScreen(suyo) || respetaPorSuCuenta(suyo),
          `${nombre} delega el borde de abajo en ${rel}, y ${rel} no lo respeta`,
        );
      }
      continue;
    }
    sinDecir.push(nombre);
  }
  assert.deepEqual(
    sinDecir,
    [],
    'Estas pantallas se pintan debajo de los botones de Android. Usa `AppScreen` ' +
      '(o `useEspacioInferior()` / `insets.bottom` si es a pantalla completa).',
  );
});

test('en las pestañas, AppScreen deja sitio a la capsula flotante', () => {
  const tapadas: string[] = [];
  for (const nombre of PANTALLAS) {
    if (!EN_PESTANAS.has(nombre)) continue;
    const codigo = sinComentarios(fuente(`screens/${nombre}.tsx`));
    if (!usaAppScreen(codigo)) continue;
    if (!/useEspacioInferior\(\)|espacioParaLaBarra\(/.test(codigo)) tapadas.push(nombre);
  }
  assert.deepEqual(
    tapadas,
    [],
    'En las pestañas `AppScreen` no aparta nada abajo: sin `useEspacioInferior()` lo ' +
      'ultimo queda debajo de la capsula (antes eran numeros a mano, como 120 o spacing.xl).',
  );
});

test('fuera de las pestañas, la zona segura no se suma dos veces', () => {
  const dobles: string[] = [];
  for (const nombre of PANTALLAS) {
    if (EN_PESTANAS.has(nombre)) continue;
    const codigo = sinComentarios(fuente(`screens/${nombre}.tsx`));
    const conBordesPorOmision = /<AppScreen\b(?![^>]*\bedges=)/.test(codigo);
    if (conBordesPorOmision && /useEspacioInferior\(\)|insets\.bottom/.test(codigo)) dobles.push(nombre);
  }
  assert.deepEqual(
    dobles,
    [],
    '`AppScreen` ya aparta la zona segura fuera de las pestañas. Sumarla otra vez en la ' +
      'misma pantalla deja el hueco doble (`useEspacioInferior()` llamado POR ENCIMA del ' +
      '`AppScreen` todavia no sabe que esta apartada).',
  );
});

test('quien fija los bordes de AppScreen a mano no se olvida del de abajo', () => {
  const olvidos: string[] = [];
  for (const nombre of PANTALLAS) {
    const codigo = sinComentarios(fuente(`screens/${nombre}.tsx`));
    for (const m of codigo.matchAll(/<AppScreen\b[^>]*\bedges=\{\[([^\]]*)\]\}/g)) {
      if (m[1].includes("'bottom'")) continue;
      // Vale si lo aparta otro contenedor de la misma pantalla (el Quiz: el
      // pie va fuera del AppScreen y la raiz es la que respeta el borde).
      if (!respetaPorSuCuenta(codigo)) olvidos.push(nombre);
    }
  }
  assert.deepEqual(olvidos, []);
});
