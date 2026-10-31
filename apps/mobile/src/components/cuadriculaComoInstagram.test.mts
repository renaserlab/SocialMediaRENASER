import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * La cuadricula del perfil tiene la forma de la de Instagram: celdas
 * verticales 3:4, separadas por una linea de 1 px y con la foto recortada
 * desde el centro.
 *
 * Mira el CODIGO FUENTE, como `cuadriculaSinReproductores`: el proyecto no
 * tiene renderizador de React Native en las pruebas, y lo que hay que impedir
 * no es una cuenta mal hecha (eso lo cubre `lib/gridLayout.test.mts`) sino que
 * una celda vuelva a dibujarse con `height: lado` —cuadrada— aunque la
 * proporcion siga bien declarada.
 *
 * Por que 3:4. Instagram cambio en enero de 2025 los cuadrados del perfil por
 * rectangulos «altos» (Adam Mosseri en Threads, 19/01/2025: «We launched a new
 * tall grid on the Instagram profile this week»). Su web dibuja cada celda con
 * `padding-bottom: 133.33%` y `object-fit: cover`, y 1 px entre celdas. No es
 * la proporcion de las publicaciones en el feed (4:5 y, desde mayo de 2025,
 * tambien 3:4): es la de la celda del perfil.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

test('la proporcion y la separacion estan declaradas en un solo sitio', () => {
  const reparto = fuente('lib/gridLayout.ts');
  assert.match(
    reparto,
    /export const GRID_TILE_ASPECT_RATIO = 3 \/ 4;/,
    'La celda del perfil es 3:4 (ancho entre alto), la de Instagram.',
  );
  assert.match(reparto, /export const GRID_GAP = 1;/, 'Instagram separa las celdas con 1 px.');
});

test('las celdas de la galeria son verticales, no cuadradas', () => {
  const galeria = fuente('components/ProfileGallery.tsx');
  assert.match(
    galeria,
    /const alto = gridItemHeight\(lado\);/,
    'El alto de la celda debe salir de gridItemHeight, con la proporcion 3:4.',
  );
  assert.ok(
    !/height: lado\b/.test(galeria),
    'Hay una celda con `height: lado`: volveria a ser cuadrada.',
  );
  // La celda con foto y la de espera: las dos con la misma forma, para que al
  // llegar las publicaciones nada se mueva.
  const celdas = galeria.match(/\{ width: lado, height: alto, backgroundColor: colors\.surfaceAlt \}/g);
  assert.equal(celdas?.length, 2, 'La celda de espera y la publicada deben medir lo mismo.');
});

test('el esqueleto del perfil reserva celdas de la misma forma', () => {
  const perfil = fuente('screens/ProfileScreen.tsx');
  const desde = perfil.indexOf('function EsqueletoDePerfil');
  assert.ok(desde !== -1, 'No se encuentra EsqueletoDePerfil en ProfileScreen.tsx.');
  const esqueleto = perfil.slice(desde, perfil.indexOf('\nfunction ', desde + 1));
  assert.match(esqueleto, /const alto = gridItemHeight\(lado\);/);
  assert.match(esqueleto, /\{ width: lado, height: alto \}/);
  assert.ok(!/height: lado\b/.test(esqueleto), 'El esqueleto dibuja celdas cuadradas.');
});

test('la foto llena la celda recortada desde el centro', () => {
  const galeria = fuente('components/ProfileGallery.tsx');
  assert.match(galeria, /contentFit="cover"\s+contentPosition="center"/);
  // Los videos: su poster tambien llena la celda, en el movil y en la web.
  assert.match(fuente('components/VideoTile.tsx'), /contentFit="cover"/);
  assert.match(fuente('components/VideoTile.web.tsx'), /objectFit: 'cover'/);
});
