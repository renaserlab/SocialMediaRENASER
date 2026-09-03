import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EL ENCUADRE DE UNA PUBLICACION: LA PREVIA TIENE QUE DECIR LA VERDAD.
 *
 * Del informe de preproduccion, con sus palabras: «cuando se quiere publicar,
 * ya no aparece un recortador de fotos – ¿si?, revisa ese detalle».
 *
 * No lo hay, y ese no era el problema. El problema es que la pantalla se
 * comportaba como si lo hubiera:
 *
 *   1. La cuadricula del carrete TIRABA las medidas del archivo, aunque
 *      `MediaLibrary` las trae y `PickedMedia` tiene los campos justamente
 *      «para la proporcion del hueco». Sin medidas, nada de lo que viene
 *      despues puede saber como va a quedar la foto.
 *   2. La previa se pintaba `cover` a pantalla completa. En un movil eso
 *      recorta los lados de casi cualquier foto, asi que se componia una imagen
 *      que el muro luego no reproducia: el muro la ensena entera salvo que sea
 *      extremadamente alargada (ver `PostImage`).
 *   3. Y la salida de emergencia —el selector del sistema, cuando la cuadricula
 *      no puede leer el carrete— pedia un recorte 9:16 de HISTORIA aunque lo
 *      que se estuviera creando fuera una publicacion. O sea: por una puerta no
 *      se recortaba nada y por la otra se recortaba a forma de historia.
 *
 * Estas comprobaciones miran el CODIGO FUENTE, como el resto de pruebas moviles
 * del proyecto: montar la vista pediria un renderizador de React Native que
 * aqui no existe, y lo que hay que impedir no es un numero mal calculado sino
 * que alguien vuelva a separar la previa del encuadre real.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..', '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const PUBLICACION = fuente('components/crear/ModoPublicacion.tsx');
const GALERIA = fuente('screens/StoryGalleryScreen.tsx');
const CAPTURA = fuente('components/crear/PasoDeCaptura.tsx');
const FOTO_DEL_MURO = fuente('components/PostImage.tsx');

// ---------------------------------------------------------------------------
// 1. Las medidas del archivo llegan hasta el final
// ---------------------------------------------------------------------------

test('la cuadricula del carrete conserva el ancho y el alto', () => {
  const eleccion = GALERIA.slice(
    GALERIA.indexOf('const choose = (asset: MediaLibrary.Asset)'),
    GALERIA.indexOf('if (loading)'),
  );
  assert.notEqual(eleccion.length, 0, 'No se encuentra el manejador de eleccion.');
  assert.match(eleccion, /width: asset\.width \?\? null/);
  assert.match(eleccion, /height: asset\.height \?\? null/);
});

// ---------------------------------------------------------------------------
// 2. Una sola regla de encuadre, la del muro
// ---------------------------------------------------------------------------

test('el encuadre lo decide una funcion exportada, no una copia', () => {
  assert.match(FOTO_DEL_MURO, /export function encuadreDePublicacion\(/);
  assert.match(PUBLICACION, /import \{ encuadreDePublicacion \} from '@\/components\/PostImage'/);
  assert.match(PUBLICACION, /encuadreDePublicacion\(elegido\.width, elegido\.height\)/);
});

test('la previa no lleva los limites de proporcion escritos a mano', () => {
  /*
    Copiar 1.91 y 0.8 aqui funcionaria hoy y divergiria en cuanto alguien
    ajustara uno de los dos lados. Los numeros viven en `PostImage` y solo ahi.
  */
  for (const numero of ['1.91', '0.8', '4 / 5', '9 / 16']) {
    assert.ok(
      !PUBLICACION.includes(numero),
      `ModoPublicacion escribe ${numero} a mano: el encuadre sale de PostImage.`,
    );
  }
});

test('sin medidas se ensena la foto entera, nunca recortada', () => {
  /*
    La camara del aparato no siempre informa las medidas. Equivocarse ensenando
    de MAS es recuperable —se publica algo un poco mas ajustado de lo que se
    vio—; ensenar de menos es prometer un recorte que no existe.
  */
  const rama = PUBLICACION.slice(PUBLICACION.indexOf('const encuadre ='));
  assert.match(rama, /contentFit="contain"/);
  assert.ok(
    !/kind === 'video'[\s\S]{0,400}contentFit="cover"/.test(rama),
    'El video de una publicacion vuelve a pintarse recortado; el muro lo ensena entero.',
  );
});

// ---------------------------------------------------------------------------
// 3. Publicar no es una historia
// ---------------------------------------------------------------------------

test('publicar no pide el recorte vertical de una historia', () => {
  assert.match(PUBLICACION, /recorte="ninguno"/);
});

test('historia y reel conservan su 9:16', () => {
  // El valor por defecto no cambia: quien no diga nada sigue recortando 9:16.
  assert.match(CAPTURA, /recorte = \[9, 16\]/);
  assert.match(GALERIA, /recorte = \[9, 16\]/);
  for (const modo of ['components/crear/ModoHistoria.tsx', 'components/crear/ModoReel.tsx']) {
    assert.ok(
      !fuente(modo).includes('recorte='),
      `${modo} no debe tocar el recorte: su valor por defecto ya es el suyo.`,
    );
  }
});

test('las dos puertas al carrete se comportan igual', () => {
  /*
    La cuadricula y el selector del sistema son la MISMA accion para quien la
    usa. Que una recortara y la otra no era el origen de la pregunta del
    informe: el recortador aparecia o no segun que permisos tuviera el telefono.
  */
  for (const [nombre, texto] of [
    ['StoryGalleryScreen', GALERIA],
    ['PasoDeCaptura', CAPTURA],
  ] as const) {
    assert.match(
      texto,
      /recorte === 'ninguno' \? \{ allowsEditing: false \} : \{ aspect: recorte \}/,
      `${nombre} vuelve a decidir el recorte por su cuenta.`,
    );
  }
  assert.ok(
    !/aspect: \[9, 16\]/.test(GALERIA),
    'La galeria vuelve a forzar 9:16 sin mirar para que se esta eligiendo.',
  );
});
