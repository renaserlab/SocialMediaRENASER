import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AHORRO_MINIMO,
  BYTES_SIN_REDUCIR,
  CALIDAD_JPEG,
  LADO_MAXIMO_PX,
  PIXELES_MAXIMOS,
  cabeEnMemoria,
  convieneLaReducida,
  esFotoReducible,
  hayQueReducir,
  leerCabeceraJpeg,
  medidasOrientadas,
  medidasReducidas,
  orientacionRespetada,
  pasosDeEscalado,
} from './reduccionDeFoto.ts';

/**
 * QUE UNA FOTO DE HISTORIA SUBIDA DESDE LA WEB PESE LO QUE PESA DESDE LA APP.
 *
 * Auditoria del 28/10/2026, §11, punto 3: las historias no tienen derivados, y
 * desde la web se subia el original de la camara (3–6 MB) que despues bajaba
 * entero cada espectador. Aqui se prueba lo que decide si se reduce, a que
 * medida, y la lectura del EXIF que impide que una foto vertical salga tumbada.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// --------------------------------------------------------------------------
// JPEG de juguete: solo cabecera, que es lo unico que se lee
// --------------------------------------------------------------------------

const u16 = (n: number, le = false) => (le ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
const u32 = (n: number, le = false) => {
  const be = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return le ? be.reverse() : be;
};
const segmento = (marcador: number, cuerpo: number[]) => [
  0xff,
  marcador,
  ...u16(cuerpo.length + 2),
  ...cuerpo,
];

/** APP1 con EXIF cuyo IFD0 lleva `etiquetas` (tipo SHORT, un valor). */
function app1Exif(etiquetas: Array<[number, number]>, le: boolean): number[] {
  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42, le),
    ...u32(8, le),
    ...u16(etiquetas.length, le),
  ];
  for (const [etiqueta, valor] of etiquetas) {
    tiff.push(...u16(etiqueta, le), ...u16(3, le), ...u32(1, le), ...u16(valor, le), 0, 0);
  }
  tiff.push(...u32(0, le)); // sin IFD siguiente
  return segmento(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}

const sof = (ancho: number, alto: number, marcador = 0xc0) =>
  segmento(marcador, [8, ...u16(alto), ...u16(ancho), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const dqt = () => segmento(0xdb, [0, ...new Array<number>(64).fill(1)]);
const dht = () => segmento(0xc4, [0, ...new Array<number>(16).fill(0)]);
const sos = () => [...segmento(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0xff, 0xd9];

function jpeg(...partes: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...partes.flat()]);
}

/** Lo que guarda un movil en vertical: pixeles apaisados y «gira 90°» en el EXIF. */
const VERTICAL_DE_MOVIL = jpeg(app1Exif([[0x0112, 6]], false), dqt(), sof(4000, 3000), dht(), sos());

// --------------------------------------------------------------------------

describe('el objetivo es el mismo que el de la aplicacion instalada', () => {
  /*
    La app llama a `Image.compress(uri, { compressionMethod: 'auto' })` sin mas
    opciones, asi que lo que sube lo deciden los valores por defecto de la
    libreria. Si alguien le pasa medidas a mano, o la libreria cambia los
    suyos, la web dejaria de subir lo mismo sin que nadie lo notara.
  */
  it('la app comprime en modo auto sin medidas propias', () => {
    const compresor = sinComentarios(fuente('services/mediaCompressor.ts'));
    assert.match(compresor, /native\.Image\.compress\(uri, \{ compressionMethod: 'auto' \}\)/);
  });

  it('el modo auto de react-native-compressor es 1280 px a calidad 0,8, en Android y en iOS', () => {
    const raiz = dirname(
      createRequire(import.meta.url).resolve('react-native-compressor/package.json'),
    );
    const android = readFileSync(
      join(raiz, 'android/src/main/java/com/reactnativecompressor/Image/ImageCompressorOptions.kt'),
      'utf8',
    );
    const ios = readFileSync(join(raiz, 'ios/Image/ImageCompressorOptions.swift'), 'utf8');
    assert.match(android, new RegExp(`var maxWidth = ${LADO_MAXIMO_PX}\\b`));
    assert.match(android, new RegExp(`var maxHeight = ${LADO_MAXIMO_PX}\\b`));
    assert.match(android, new RegExp(`var quality = ${CALIDAD_JPEG}f`));
    assert.match(ios, new RegExp(`var maxWidth: Int = ${LADO_MAXIMO_PX}\\b`));
    assert.match(ios, new RegExp(`var maxHeight: Int = ${LADO_MAXIMO_PX}\\b`));
    assert.match(ios, new RegExp(`var quality: Float = ${CALIDAD_JPEG}\\b`));
  });
});

describe('esFotoReducible: solo JPEG', () => {
  it('acepta JPEG por tipo', () => {
    for (const tipo of ['image/jpeg', 'IMAGE/JPEG', 'image/jpg', 'image/pjpeg']) {
      assert.equal(esFotoReducible(tipo, null), true, tipo);
    }
  });

  it('rechaza lo que puede traer transparencia, animacion o no abrirse', () => {
    for (const tipo of ['image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif']) {
      assert.equal(esFotoReducible(tipo, 'foto.jpg'), false, tipo);
    }
  });

  it('sin tipo, mira la extension del nombre', () => {
    assert.equal(esFotoReducible(null, 'IMG_0001.JPG'), true);
    assert.equal(esFotoReducible('', 'foto.jpeg'), true);
    assert.equal(esFotoReducible(undefined, 'IMG_0001.HEIC'), false);
    assert.equal(esFotoReducible(null, null), false);
  });
});

describe('hayQueReducir: solo se deja tal cual lo que ya es pequeno en medidas Y en peso', () => {
  const MB = 1024 * 1024;

  it('una foto de camara se reduce', () => {
    assert.equal(hayQueReducir({ ancho: 4000, alto: 3000, bytes: 4 * MB }), true);
    assert.equal(hayQueReducir({ ancho: 3000, alto: 4000, bytes: 3 * MB }), true);
  });

  it('una foto que ya cabe y pesa poco no se toca', () => {
    assert.equal(hayQueReducir({ ancho: 1280, alto: 960, bytes: 300 * 1024 }), false);
    assert.equal(hayQueReducir({ ancho: 1024, alto: 1280, bytes: BYTES_SIN_REDUCIR }), false);
  });

  it('pequena en medidas pero pesada: se recodifica', () => {
    assert.equal(hayQueReducir({ ancho: 1200, alto: 900, bytes: BYTES_SIN_REDUCIR + 1 }), true);
  });

  it('ligera pero mas grande que el objetivo: se reduce', () => {
    assert.equal(hayQueReducir({ ancho: 1920, alto: 1080, bytes: 200 * 1024 }), true);
  });

  it('sin medidas fiables hay que abrirla para saberlo', () => {
    assert.equal(hayQueReducir({ ancho: 0, alto: 0, bytes: 100 }), true);
    assert.equal(hayQueReducir({ ancho: null, alto: 900, bytes: 100 }), true);
    assert.equal(hayQueReducir({ bytes: 100 }), true);
  });
});

describe('cabeEnMemoria: no se decodifica lo que puede cerrar la pestana', () => {
  it('12 MP, lo que guarda un movil por defecto, y 24 MP si', () => {
    assert.equal(cabeEnMemoria({ ancho: 4000, alto: 3000 }), true);
    assert.equal(cabeEnMemoria({ ancho: 3024, alto: 4032 }), true);
    assert.equal(cabeEnMemoria({ ancho: 6000, alto: 4000 }), true);
    assert.equal(cabeEnMemoria({ ancho: 5000, alto: PIXELES_MAXIMOS / 5000 }), true);
  });

  it('50 y 108 MP no: se sube el original', () => {
    assert.equal(cabeEnMemoria({ ancho: 8160, alto: 6120 }), false);
    assert.equal(cabeEnMemoria({ ancho: 12000, alto: 9000 }), false);
  });
});

describe('medidasReducidas', () => {
  it('lado mayor a 1280 en proporcion, apaisada y vertical', () => {
    assert.deepEqual(medidasReducidas({ ancho: 4000, alto: 3000 }), { ancho: 1280, alto: 960 });
    assert.deepEqual(medidasReducidas({ ancho: 3000, alto: 4000 }), { ancho: 960, alto: 1280 });
    assert.deepEqual(medidasReducidas({ ancho: 3024, alto: 4032 }), { ancho: 960, alto: 1280 });
    assert.deepEqual(medidasReducidas({ ancho: 4080, alto: 3060 }), { ancho: 1280, alto: 960 });
  });

  it('nunca amplia', () => {
    assert.deepEqual(medidasReducidas({ ancho: 1080, alto: 1080 }), { ancho: 1080, alto: 1080 });
    assert.deepEqual(medidasReducidas({ ancho: 1280, alto: 1280 }), { ancho: 1280, alto: 1280 });
  });

  it('una tira muy fina no se queda en cero', () => {
    assert.deepEqual(medidasReducidas({ ancho: 8000, alto: 2 }), { ancho: 1280, alto: 1 });
  });
});

describe('pasosDeEscalado: por mitades y el ultimo exacto', () => {
  it('4000x3000 a 1280x960', () => {
    assert.deepEqual(pasosDeEscalado({ ancho: 4000, alto: 3000 }, { ancho: 1280, alto: 960 }), [
      { ancho: 2000, alto: 1500 },
      { ancho: 1280, alto: 960 },
    ]);
  });

  it('48 MP: tres pasos', () => {
    assert.deepEqual(pasosDeEscalado({ ancho: 8000, alto: 6000 }, { ancho: 1280, alto: 960 }), [
      { ancho: 4000, alto: 3000 },
      { ancho: 2000, alto: 1500 },
      { ancho: 1280, alto: 960 },
    ]);
  });

  it('si la mitad ya es el destino, no se repite', () => {
    assert.deepEqual(pasosDeEscalado({ ancho: 2560, alto: 1920 }, { ancho: 1280, alto: 960 }), [
      { ancho: 1280, alto: 960 },
    ]);
  });

  it('sin cambio de medidas queda un paso: el lienzo donde se codifica', () => {
    assert.deepEqual(pasosDeEscalado({ ancho: 1000, alto: 800 }, { ancho: 1000, alto: 800 }), [
      { ancho: 1000, alto: 800 },
    ]);
  });

  it('ningun paso intermedio queda por debajo del destino', () => {
    const destino = medidasReducidas({ ancho: 3024, alto: 4032 });
    for (const paso of pasosDeEscalado({ ancho: 3024, alto: 4032 }, destino)) {
      assert.ok(paso.ancho >= destino.ancho && paso.alto >= destino.alto, JSON.stringify(paso));
    }
  });
});

describe('convieneLaReducida', () => {
  it('se queda con la reducida si ahorra al menos un 10 %', () => {
    assert.equal(convieneLaReducida(4_000_000, 300_000), true);
    assert.equal(convieneLaReducida(1000, 1000 * (1 - AHORRO_MINIMO)), true);
  });

  it('si apenas ahorra, o pesa mas, o salio vacia, se sube el original', () => {
    assert.equal(convieneLaReducida(1000, 950), false);
    assert.equal(convieneLaReducida(1000, 1200), false);
    assert.equal(convieneLaReducida(1000, 0), false);
  });
});

describe('leerCabeceraJpeg', () => {
  it('lee medidas guardadas y orientacion de un movil en vertical', () => {
    assert.deepEqual(leerCabeceraJpeg(VERTICAL_DE_MOVIL), { ancho: 4000, alto: 3000, orientacion: 6 });
  });

  it('EXIF en orden Intel (II) y Motorola (MM)', () => {
    for (const le of [true, false]) {
      const bytes = jpeg(app1Exif([[0x010f, 7], [0x0112, 8]], le), sof(3000, 4000), sos());
      assert.deepEqual(leerCabeceraJpeg(bytes), { ancho: 3000, alto: 4000, orientacion: 8 }, String(le));
    }
  });

  it('sin EXIF, o sin la etiqueta, es orientacion 1', () => {
    assert.deepEqual(leerCabeceraJpeg(jpeg(dqt(), sof(1920, 1080), sos())), {
      ancho: 1920,
      alto: 1080,
      orientacion: 1,
    });
    assert.equal(leerCabeceraJpeg(jpeg(app1Exif([[0x010f, 1]], true), sof(10, 20), sos()))?.orientacion, 1);
  });

  it('una orientacion fuera de 1–8 se trata como 1', () => {
    assert.equal(leerCabeceraJpeg(jpeg(app1Exif([[0x0112, 0]], true), sof(10, 20)))?.orientacion, 1);
    assert.equal(leerCabeceraJpeg(jpeg(app1Exif([[0x0112, 9]], true), sof(10, 20)))?.orientacion, 1);
  });

  it('ignora un APP1 que no es EXIF (XMP) y el relleno 0xFF entre segmentos', () => {
    const xmp = segmento(0xe1, [...Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>')]);
    const bytes = jpeg(xmp, [0xff, 0xff], app1Exif([[0x0112, 3]], false), sof(640, 480), sos());
    assert.deepEqual(leerCabeceraJpeg(bytes), { ancho: 640, alto: 480, orientacion: 3 });
  });

  it('progresivo (SOF2) tambien; una tabla DHT no se confunde con las medidas', () => {
    const bytes = jpeg(dht(), sof(1200, 1600, 0xc2), sos());
    assert.deepEqual(leerCabeceraJpeg(bytes), { ancho: 1200, alto: 1600, orientacion: 1 });
  });

  it('lo que no es un JPEG entero no se adivina', () => {
    // PNG
    assert.equal(leerCabeceraJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
    // Datos de imagen antes de las medidas.
    assert.equal(leerCabeceraJpeg(jpeg(sos(), sof(10, 10))), null);
    // Cortado a mitad de la cabecera.
    assert.equal(leerCabeceraJpeg(VERTICAL_DE_MOVIL.subarray(0, 40)), null);
    // Vacio, o medidas a cero.
    assert.equal(leerCabeceraJpeg(new Uint8Array(0)), null);
    assert.equal(leerCabeceraJpeg(jpeg(sof(0, 100))), null);
  });

  it('un EXIF roto no rompe la lectura de las medidas', () => {
    const roto = segmento(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 42, 0, 0xff, 0xff, 0, 0]);
    assert.deepEqual(leerCabeceraJpeg(jpeg(roto, sof(800, 600), sos())), {
      ancho: 800,
      alto: 600,
      orientacion: 1,
    });
  });
});

describe('orientacion: una foto vertical no puede salir tumbada', () => {
  it('con 5 a 8 el ancho y el alto se cruzan; con 1 a 4, no', () => {
    for (let o = 1; o <= 8; o += 1) {
      const vista = medidasOrientadas({ ancho: 4000, alto: 3000, orientacion: o });
      assert.deepEqual(vista, o >= 5 ? { ancho: 3000, alto: 4000 } : { ancho: 4000, alto: 3000 }, `o=${o}`);
    }
  });

  it('acepta la decodificacion girada y rechaza la que ignoro el EXIF', () => {
    const cabecera = leerCabeceraJpeg(VERTICAL_DE_MOVIL)!;
    assert.equal(orientacionRespetada(cabecera, { ancho: 3000, alto: 4000 }), true);
    assert.equal(orientacionRespetada(cabecera, { ancho: 4000, alto: 3000 }), false);
  });

  it('una decodificacion con otras medidas (reducida, recortada) tampoco pasa', () => {
    const cabecera = { ancho: 4000, alto: 3000, orientacion: 1 };
    assert.equal(orientacionRespetada(cabecera, { ancho: 4000, alto: 3000 }), true);
    assert.equal(orientacionRespetada(cabecera, { ancho: 2000, alto: 1500 }), false);
  });
});

describe('quien la usa', () => {
  const modo = sinComentarios(fuente('components/crear/ModoHistoria.tsx'));
  const web = sinComentarios(fuente('services/reducirFoto.web.ts'));
  const movil = sinComentarios(fuente('services/reducirFoto.ts'));

  it('la historia sube lo preparado, no lo elegido, y suelta la copia pase lo que pase', () => {
    const preparar = modo.indexOf('prepararFotoParaSubir(elegido, avance)');
    const subir = modo.indexOf('uploadPostMedia(foto.media, avance)');
    assert.ok(preparar > 0, 'prepara la foto');
    assert.ok(subir > preparar, 'y sube la preparada despues');
    assert.doesNotMatch(modo, /uploadPostMedia\(elegido/);
    assert.match(modo, /finally \{\s*foto\.liberar\(\);\s*\}/);
  });

  it('en el movil no se toca nada: alli comprime react-native-compressor', () => {
    assert.match(movil, /return \{ media, liberar: \(\) => \{\} \};/);
    assert.doesNotMatch(movil, /createImageBitmap|canvas|compress/i);
  });

  it('en web: gira segun el EXIF, lo comprueba y nunca lanza', () => {
    assert.match(web, /imageOrientation: 'from-image'/);
    assert.ok(
      web.indexOf('cabeEnMemoria(origen)') > 0 &&
        web.indexOf('cabeEnMemoria(origen)') < web.indexOf('createImageBitmap(original'),
      'mira la memoria ANTES de decodificar',
    );
    assert.match(web, /orientacionRespetada\(cabecera/);
    assert.match(web, /catch \{\s*return sinTocar\(media\);\s*\}/);
    assert.match(web, /toBlob\(resolve, 'image\/jpeg', CALIDAD_JPEG\)/);
  });
});
