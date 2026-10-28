import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * IMPRESIONES SOLO CON LA SECCIÓN DELANTE, Y PORTADAS PRIVADAS GUARDADAS POR RUTA.
 *
 * Auditoría del 27/10/2026, §6.3 y §6.4.
 *
 * §6.3. `SwipeTabs` monta Explorar 700 ms después de Inicio, y los dos
 * carruseles de recomendación contaban impresiones desde allí, con la pantalla
 * fuera de la vista. Medido en la web exportada contra un simulador con
 * sesión: 2 impresiones de «Cursos para ti» y 2 de «Personas para ti»
 * mandadas en un arranque que se queda en Inicio. Con esto, 0 y 0; con
 * Explorar delante siguen saliendo las mismas.
 *
 * Lo que NO se cambia, por decisión: Explorar sigue PIDIENDO todo al montarse,
 * para estar ya lleno cuando se llega. La auditoría proponía esperar al primer
 * foco; se midió y la primera apertura pasaba a enseñar esqueletos durante lo
 * que tarda la red. Se prefirió como estaba.
 *
 * §6.4. Portadas del bucket privado pintadas sin `cacheKey` o con el `Image`
 * de React Native, que guarda por URL: cada firma nueva —la firma dura una
 * hora— volvía a descargar la misma foto. OJO: en la web expo-image IGNORA
 * `cacheKey` (pinta un <img> y la cache es la del navegador, por URL), así que
 * esto no se puede medir allí; por eso se comprueba el código.
 *
 * Como el resto de baterías de pantallas, se mira el CÓDIGO FUENTE: montar las
 * pantallas pediría un renderizador de React Native que estas pruebas no tienen.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\}/g, '{}').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------------------
// 1. Las impresiones solo cuentan con la sección delante
// ---------------------------------------------------------------------------

describe('impresiones de los carruseles de recomendación', () => {
  /*
    Cada impresión lleva clave y no se repite en la sesión. Contarla con la
    sección fuera de la vista no solo inflaba la cifra: se comía la impresión
    de verdad, la de cuando la persona llegaba a mirar.
  */
  for (const componente of ['CursosParaTi', 'PersonasParaTi']) {
    it(`${componente} no mide nada fuera de la vista y vuelve a medir al volver`, () => {
      const codigo = sinComentarios(fuente(`components/${componente}.tsx`));
      assert.match(codigo, /const activa = useSeccionActiva\(\);/);
      assert.match(
        codigo,
        /const medirVisibles = useCallback\(\s*\(desplazamiento: number\) => \{\s*if \(!activa\) return;/,
      );
      // `activa` en las dependencias: al volver cambia la función y el efecto
      // de «lista nueva» mide otra vez lo que hay delante.
      assert.match(codigo, /\[activa, (visibles, )?datos\],\s*\);\s*const alMedirAncho/);
    });

    it(`${componente} sigue pidiendo su lista al montarse`, () => {
      // La decisión de arriba: Explorar llega ya lleno. Solo la impresión espera.
      const codigo = sinComentarios(fuente(`components/${componente}.tsx`));
      assert.match(codigo, /useEffect\(cargar, \[cargar\]\);/);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Portadas privadas con la RUTA como clave de cache
// ---------------------------------------------------------------------------

describe('portadas del bucket privado: cacheKey = ruta de Storage', () => {
  const CASOS: Array<[archivo: string, objeto: string, veces: number]> = [
    ['components/CourseCard.tsx', 'course', 1],
    ['components/CursosParaTi.tsx', 'curso', 1],
    ['screens/CursosScreen.tsx', 'curso', 3],
    ['screens/EventsScreen.tsx', 'event', 2],
    ['screens/EventoScreen.tsx', 'evento', 1],
    ['screens/CourseScreen.tsx', 'course', 1],
    ['screens/ExploreScreen.tsx', 'event', 1],
  ];

  for (const [archivo, objeto, veces] of CASOS) {
    it(`${archivo}: cada portada remota lleva su ruta`, () => {
      const codigo = sinComentarios(fuente(archivo));
      const conClave = new RegExp(
        `\\{ uri: ${objeto}\\.coverUrl, cacheKey: ${objeto}\\.coverPath \\?\\? undefined \\}`,
        'g',
      );
      assert.equal(codigo.match(conClave)?.length ?? 0, veces);
      const sinClave = new RegExp(`\\{ uri: ${objeto}\\.coverUrl \\}`);
      assert.ok(!sinClave.test(codigo), `${archivo}: queda una portada sin cacheKey`);
    });
  }

  it('las pantallas que usaban el Image de React Native ya no lo usan para portadas remotas', () => {
    for (const archivo of ['screens/EventsScreen.tsx', 'screens/EventoScreen.tsx', 'screens/CourseScreen.tsx']) {
      const codigo = sinComentarios(fuente(archivo));
      const deReactNative = codigo.match(/import \{([^}]*)\} from 'react-native';/)?.[1] ?? '';
      assert.ok(!/\bImage\b/.test(deReactNative), `${archivo}: sigue importando Image de react-native`);
      assert.match(codigo, /import \{ Image as ExpoImage \} from 'expo-image';/);
    }
    // En Explorar el Image de React Native queda solo para la ilustración local.
    const explorar = sinComentarios(fuente('screens/ExploreScreen.tsx'));
    const usos = explorar.match(/<Image\s[^>]*?source=\{([^}]+)\}/g) ?? [];
    assert.ok(usos.length > 0);
    for (const uso of usos) assert.match(uso, /source=\{assets\./, 'una portada remota con el Image de React Native');
  });

  it('se ven igual que con el Image de React Native: cover y el mismo fundido', () => {
    const fundido = sinComentarios(fuente('lib/fundidoDeImagen.ts'));
    // 300 ms en Android (`fadeDuration` por defecto) y ninguno en iOS ni web.
    assert.match(fundido, /Platform\.OS === 'android' \? 300 : 0/);

    const CAMBIADAS: Array<[archivo: string, veces: number]> = [
      ['screens/EventsScreen.tsx', 2],
      ['screens/EventoScreen.tsx', 1],
      ['screens/CourseScreen.tsx', 1],
    ];
    for (const [archivo, veces] of CAMBIADAS) {
      const imagenes = sinComentarios(fuente(archivo)).match(/<ExpoImage[\s\S]*?\/>/g) ?? [];
      assert.equal(imagenes.length, veces, archivo);
      for (const imagen of imagenes) {
        assert.match(imagen, /contentFit="cover"/, archivo);
        assert.match(imagen, /transition=\{FUNDIDO_DEL_IMAGE_DE_REACT_NATIVE\}/, archivo);
      }
    }
    const evento = sinComentarios(fuente('screens/ExploreScreen.tsx')).match(
      // Sin cruzar un `/>`: la primera ExpoImage de Explorar es la del compositor.
      /<ExpoImage(?:(?!\/>)[\s\S])*?event\.coverPath[\s\S]*?\/>/,
    )?.[0];
    assert.ok(evento);
    assert.match(evento, /contentFit="cover"/);
    assert.match(evento, /transition=\{FUNDIDO_DEL_IMAGE_DE_REACT_NATIVE\}/);
  });
});

// ---------------------------------------------------------------------------
// 3. Avatar en filas recicladas
// ---------------------------------------------------------------------------

describe('Avatar y las filas que recicla una FlashList', () => {
  it('pasa la clave tal cual, sin inventarla a partir de la URL', () => {
    const avatar = sinComentarios(fuente('components/Avatar.tsx'));
    assert.match(avatar, /recyclingKey\?: string;/);
    assert.match(avatar, /recyclingKey=\{recyclingKey\}/);
  });

  it('el chat del directo la usa con quien escribe', () => {
    const chat = sinComentarios(fuente('components/live/ChatDeDirecto.tsx'));
    assert.match(chat, /<Avatar[\s\S]*?recyclingKey=\{mensaje\.usuarioId\}[\s\S]*?\/>/);
  });
});
