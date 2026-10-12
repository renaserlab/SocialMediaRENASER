import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_BYTES_A_CARPETA,
  aspectoDeArchivo,
  avanceDelEnvio,
  cabeEnLaCarpeta,
  conExtension,
  destinoDeDescarga,
  detalleDeArchivo,
  duracionDeVideo,
  esRutaDePortada,
  medioQueEs,
  nombreLocalDePortada,
  nombreParaGuardar,
  pesoLegible,
  rutaDePortada,
  seComprime,
  soloLlevaMedios,
  vaSinMarco,
} from './mediosDeChat.ts';

describe('qué se achica antes de enviar', () => {
  it('una foto y un video, sí', () => {
    assert.equal(seComprime('image', 'image/jpeg', 'IMG_1.jpg'), true);
    assert.equal(seComprime('image', 'image/heic', 'IMG_1.HEIC'), true);
    assert.equal(seComprime('image', null, null), true);
    assert.equal(seComprime('video', 'video/mp4', 'clip.mp4'), true);
  });

  it('un archivo llega tal cual, aunque sea una foto', () => {
    // Quien entra por «Archivo» quiere el original.
    assert.equal(seComprime('document', 'image/jpeg', 'IMG-20261012-WA0005.jpg'), false);
    assert.equal(seComprime('document', 'application/pdf', 'contrato.pdf'), false);
    assert.equal(seComprime('audio', 'audio/mp4', 'nota.m4a'), false);
  });

  it('un GIF o un WebP no: el compresor los dejaría quietos', () => {
    assert.equal(seComprime('image', 'image/gif', 'risa.gif'), false);
    assert.equal(seComprime('image', 'image/webp', 'sticker.webp'), false);
    // El teléfono no siempre dice el tipo: entonces manda la extensión.
    assert.equal(seComprime('image', null, 'risa.GIF'), false);
  });

  it('tras comprimir, el nombre lleva la extensión de lo que es ahora', () => {
    assert.equal(conExtension('IMG_1.HEIC', 'jpg'), 'IMG_1.jpg');
    assert.equal(conExtension('mi.foto.de.hoy.png', 'jpg'), 'mi.foto.de.hoy.jpg');
    assert.equal(conExtension('sinpunto', 'mp4'), 'sinpunto.mp4');
    assert.equal(conExtension(null, 'jpg'), null);
  });
});

describe('la barra de envío cuenta también la compresión', () => {
  it('con un video, media barra es comprimir y media subir', () => {
    assert.equal(avanceDelEnvio('comprimiendo', 0, true), 0);
    assert.equal(avanceDelEnvio('comprimiendo', 1, true), 0.5);
    assert.equal(avanceDelEnvio('subiendo', 0, true), 0.5);
    assert.equal(avanceDelEnvio('subiendo', 1, true), 1);
    // Nunca retrocede al pasar de una fase a la otra.
    assert.ok(avanceDelEnvio('subiendo', 0, true) >= avanceDelEnvio('comprimiendo', 1, true));
  });

  it('con una foto, toda la barra es la subida', () => {
    assert.equal(avanceDelEnvio('comprimiendo', 0.7, false), 0);
    assert.equal(avanceDelEnvio('subiendo', 0.4, false), 0.4);
  });

  it('un avance que no es un número no rompe la barra', () => {
    assert.equal(avanceDelEnvio('subiendo', Number.NaN, false), 0);
    assert.equal(avanceDelEnvio('subiendo', 7, false), 1);
    assert.equal(avanceDelEnvio('comprimiendo', -3, true), 0);
  });
});

describe('la portada de un video', () => {
  const VIDEO = 'aaaaaaaa-0000-4000-8000-000000000003/11111111-2222-4333-8444-555555555555/k3j2.mp4';

  it('vive al lado del video, en su misma carpeta', () => {
    const portada = rutaDePortada(VIDEO);
    assert.equal(portada, `${VIDEO}.portada.jpg`);
    // La carpeta ES el permiso: conversación y persona tienen que ser las mismas.
    assert.deepEqual(portada.split('/').slice(0, 2), VIDEO.split('/').slice(0, 2));
    assert.equal(portada.split('/').length, 3);
    assert.equal(esRutaDePortada(portada), true);
    assert.equal(esRutaDePortada(VIDEO), false);
  });

  it('su copia en el teléfono lleva un nombre que una carpeta admite', () => {
    const nombre = nombreLocalDePortada(VIDEO);
    assert.match(nombre, /^[A-Za-z0-9_-]+$/);
    assert.ok(nombre.length <= 120);
    // Dos videos distintos no comparten portada.
    assert.notEqual(nombre, nombreLocalDePortada(VIDEO.replace('k3j2', 'k3j3')));
  });

  it('la duración se lee como en un reproductor', () => {
    assert.equal(duracionDeVideo(65), '1:05');
    assert.equal(duracionDeVideo(9.4), '0:09');
    assert.equal(duracionDeVideo(0), '');
    assert.equal(duracionDeVideo(null), '');
  });
});

describe('cuándo una foto va sin marco', () => {
  const foto = { kind: 'image' as const };
  const video = { kind: 'video' as const };
  const archivo = { kind: 'document' as const };

  it('una foto o un video solos, sin burbuja alrededor', () => {
    assert.equal(vaSinMarco({ adjuntos: [foto] }), true);
    assert.equal(vaSinMarco({ adjuntos: [foto, video], texto: '   ' }), true);
  });

  it('con texto, con una cita o con una historia, la burbuja se queda', () => {
    assert.equal(vaSinMarco({ adjuntos: [foto], texto: 'mira' }), false);
    assert.equal(vaSinMarco({ adjuntos: [foto], conCita: true }), false);
    assert.equal(vaSinMarco({ adjuntos: [foto], conHistoria: true }), false);
  });

  it('un archivo, una nota de voz o un mensaje borrado no pierden la burbuja', () => {
    assert.equal(vaSinMarco({ adjuntos: [archivo] }), false);
    assert.equal(vaSinMarco({ adjuntos: [foto, archivo] }), false);
    assert.equal(vaSinMarco({ adjuntos: [{ kind: 'audio' }] }), false);
    assert.equal(vaSinMarco({ adjuntos: [foto], eliminado: true }), false);
    assert.equal(vaSinMarco({ adjuntos: [] }), false);
    assert.equal(vaSinMarco({ texto: 'hola' }), false);
    assert.equal(soloLlevaMedios([foto, video]), true);
    assert.equal(soloLlevaMedios(null), false);
  });
});

describe('cómo se reconoce un archivo', () => {
  it('por su tipo, escrito en un recuadro de color', () => {
    assert.deepEqual(aspectoDeArchivo('application/pdf', 'contrato.pdf'), {
      sigla: 'PDF',
      icono: null,
      tono: 'rojo',
    });
    assert.equal(aspectoDeArchivo(null, 'notas.docx').tono, 'azul');
    assert.equal(aspectoDeArchivo(null, 'cuentas.XLSX').sigla, 'XLSX');
    assert.equal(aspectoDeArchivo(null, 'cuentas.xlsx').tono, 'verde');
  });

  it('una foto, un video, un audio y un comprimido llevan icono', () => {
    assert.equal(aspectoDeArchivo('image/jpeg', 'IMG-20261012-WA0005.jpg').icono, 'image');
    assert.equal(aspectoDeArchivo('video/mp4', 'clip.mp4').icono, 'film');
    assert.equal(aspectoDeArchivo('audio/mpeg', 'tema.mp3').icono, 'music');
    assert.equal(aspectoDeArchivo('application/zip', 'fotos.zip').icono, 'archive');
  });

  it('lo que no se reconoce no inventa un tipo', () => {
    assert.deepEqual(aspectoDeArchivo(null, 'sinextension'), {
      sigla: '',
      icono: 'file',
      tono: 'gris',
    });
    assert.equal(aspectoDeArchivo(null, null).icono, 'file');
  });

  it('debajo del nombre van el tipo y el peso', () => {
    assert.equal(detalleDeArchivo('IMG-20261012-WA0005.jpg', 687 * 1024), 'JPG · 687 KB');
    assert.equal(detalleDeArchivo('contrato.pdf', null), 'PDF');
    assert.equal(detalleDeArchivo('sinextension', 3 * 1024 * 1024), '3.0 MB');
    assert.equal(detalleDeArchivo(null, null), '');
    assert.equal(pesoLegible(500), '1 KB');
  });
});

describe('adónde va un archivo al descargarlo', () => {
  it('una foto o un video, a la galería, aunque se mandaran como archivo', () => {
    assert.equal(destinoDeDescarga('image/jpeg', 'IMG-20261012-WA0005.jpg'), 'galeria');
    assert.equal(destinoDeDescarga(null, 'clip.MP4'), 'galeria');
    assert.equal(medioQueEs('image/png', null), 'image');
    assert.equal(medioQueEs(null, 'clip.mov'), 'video');
  });

  it('todo lo demás, a la carpeta que eligió la persona', () => {
    assert.equal(destinoDeDescarga('application/pdf', 'contrato.pdf'), 'carpeta');
    assert.equal(destinoDeDescarga('audio/mpeg', 'tema.mp3'), 'carpeta');
    assert.equal(destinoDeDescarga(null, null), 'carpeta');
    assert.equal(medioQueEs('application/pdf', 'contrato.pdf'), null);
  });

  it('el nombre con el que se guarda no lleva nada que una carpeta rechace', () => {
    assert.equal(nombreParaGuardar('contrato.pdf', 'pdf'), 'contrato.pdf');
    assert.equal(nombreParaGuardar('a/b\\c:d*e?.pdf', 'pdf'), 'a_b_c_d_e_.pdf');
    assert.equal(nombreParaGuardar('informe', 'docx'), 'informe.docx');
    assert.equal(nombreParaGuardar(null, 'bin'), 'archivo-de-z.bin');
    assert.equal(nombreParaGuardar('...', 'bin'), 'archivo-de-z.bin');
    // Un nombre que empieza por punto sería un archivo oculto.
    assert.equal(nombreParaGuardar('.oculto.txt', 'txt'), 'oculto.txt');
  });

  it('lo muy grande no se intenta guardar en la carpeta', () => {
    assert.equal(cabeEnLaCarpeta(MAX_BYTES_A_CARPETA), true);
    assert.equal(cabeEnLaCarpeta(MAX_BYTES_A_CARPETA + 1), false);
    // Sin saber el peso se intenta: casi todo lo que se manda es pequeño.
    assert.equal(cabeEnLaCarpeta(null), true);
  });
});
