import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lo que se escribe no queda debajo del teclado.
 *
 * QUÉ PASABA. La aplicación es `edgeToEdgeEnabled`: en Android la ventana NO se
 * encoge al abrirse el teclado. Una pantalla con campos tiene que envolverse en
 * `SinTecladoDelante`, y las de Servicios —veinte formularios: la ficha, la
 * credencial, cancelar una reserva, abrir un caso, escribir una reseña— no lo
 * hacían. El campo de abajo se escribía a ciegas.
 *
 * CÓMO SE ARREGLÓ. `AppScreen` acepta `teclado`, que envuelve la pantalla en
 * `SinTecladoDelante`. Se PIDE, no viene de fábrica: una pantalla que ya lleva
 * el suyo se encogería dos veces.
 *
 * SE MIRA EL CÓDIGO FUENTE, como en `zonaSeguraInferior.test.mts`: comprobarlo
 * de verdad exige un teléfono con el teclado abierto.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PANTALLAS = readdirSync(CARPETA)
  .filter((nombre) => nombre.endsWith('Screen.tsx'))
  .map((nombre) => [nombre.replace('.tsx', ''), sinComentarios(fuente(`screens/${nombre}`))] as const);

/** Las pantallas de Z Servicios: las que hablan con sus bibliotecas. */
const esDeServicios = (codigo: string) =>
  /from '@\/lib\/servicios[A-Za-z]*'|from '@\/hooks\/useServicios'/.test(codigo);
const tieneCampos = (codigo: string) => /<Input\b|<TextInput\b/.test(codigo);

/**
 * El buscador del catálogo tiene su campo ARRIBA, donde el teclado no llega, y
 * su hoja de filtros es un `BottomSheet`, que ya aparta el teclado por su cuenta.
 */
const SIN_NADA_QUE_TAPAR = new Set(['ServiciosScreen']);

test('AppScreen aparta el teclado DE FÁBRICA', () => {
  // Hasta el 07/10/2026 había que pedirlo, y 49 pantallas con campos no lo
  // pedían. Podía venir apagado porque dos apartados anidados se encogían dos
  // veces; ahora, de los anidados, aparta solo el de más adentro.
  const codigo = sinComentarios(fuente('components/AppScreen.tsx'));
  assert.match(codigo, /teclado\?: boolean;/);
  assert.match(codigo, /teclado = true,/, 'vuelve a hacer falta acordarse de pedirlo');
  assert.match(codigo, /teclado \? <SinTecladoDelante>\{pantalla\}<\/SinTecladoDelante> : pantalla/);
  // Y la zona segura sigue envolviéndolo todo, con teclado o sin él.
  assert.match(codigo, /bordes\.includes\('bottom'\) \? <ReservaDeZonaSegura>\{contenido\}<\/ReservaDeZonaSegura> : contenido/);
});

test('todo formulario de Servicios aparta el teclado', () => {
  const formularios = PANTALLAS.filter(
    ([nombre, codigo]) => esDeServicios(codigo) && tieneCampos(codigo) && !SIN_NADA_QUE_TAPAR.has(nombre),
  );
  assert.ok(formularios.length >= 19, `se esperaban al menos 19 formularios y hay ${formularios.length}`);
  const tapados = formularios
    .filter(([, codigo]) => !/<AppScreen teclado\b/.test(codigo) && !/<SinTecladoDelante\b/.test(codigo))
    .map(([nombre]) => nombre);
  assert.deepEqual(
    tapados,
    [],
    'En estas pantallas el teclado tapa lo que se escribe. Usa `<AppScreen teclado …>`.',
  );
});

test('ninguna pantalla aparta el teclado dos veces', () => {
  const dobles = PANTALLAS.filter(
    ([, codigo]) => /<AppScreen teclado\b/.test(codigo) && /<SinTecladoDelante\b/.test(codigo),
  ).map(([nombre]) => nombre);
  assert.deepEqual(dobles, [], '`AppScreen teclado` ya envuelve en `SinTecladoDelante`: con los dos se encoge dos veces.');
});
