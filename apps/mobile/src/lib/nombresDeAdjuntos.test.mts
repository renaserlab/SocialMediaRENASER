import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ARCHIVOS_DE_UNA_VEZ,
  MAX_CONSULTA_DE_TEMAS,
  MAX_TITULO_DE_ADJUNTO,
  adjuntoNombrable,
  alternarSeleccion,
  aplicarTemas,
  claveDelFalloDeAgregarVarios,
  claveDelFalloDeNombre,
  conTituloDeAdjunto,
  etiquetaDeTemas,
  iconoDeTarjeta,
  idsParaPreguntarTemas,
  leerNotaDeVoz,
  leerTemasDeMensaje,
  leerTemasDeMensajes,
  leerTitulo,
  limpiarTitulo,
  mismosTemas,
  nombrePorDefecto,
  partesDeDuracion,
  puedeNombrar,
  seNombra,
  tipoDeArchivoElegido,
  type TemaDeMensaje,
} from './nombresDeAdjuntos.ts';
import { es } from '../i18n/es.ts';

/*
  Audios y temas (30/10/2026): el nombre de un adjunto y los temas de un
  mensaje. Contrato en `docs/CONTRATOS_AUDIOS_Y_TEMAS.md`. Lo que se prueba
  aquí es lo que decide la pantalla sin red: qué nombre propone un archivo,
  qué etiqueta lleva un mensaje, a quién se le ofrece renombrar y cómo se
  leen las respuestas del servidor sin fiarse.
*/

describe('el nombre con el que empieza un archivo elegido', () => {
  it('es el del fichero sin extensión, con los guiones como espacios', () => {
    assert.equal(nombrePorDefecto('respiracion-478.mp3'), 'Respiracion 478');
    assert.equal(nombrePorDefecto('cierre-semana.mp3'), 'Cierre semana');
    assert.equal(nombrePorDefecto('guia_de__habitos.pdf'), 'Guia de habitos');
    assert.equal(nombrePorDefecto('  clase--3 _ postura.mp4 '), 'Clase 3 postura');
  });

  it('empieza con mayúscula, también con tilde', () => {
    assert.equal(nombrePorDefecto('ética-y-negocio.docx'), 'Ética y negocio');
  });

  it('solo quita lo que parece una extensión', () => {
    assert.equal(nombrePorDefecto('Clase 3. Postura'), 'Clase 3. Postura');
    assert.equal(nombrePorDefecto('informe.final.pdf'), 'Informe.final');
    assert.equal(nombrePorDefecto('sin-extension'), 'Sin extension');
  });

  it('los de cámara o de WhatsApp empiezan vacíos: ese nombre no dice nada', () => {
    for (const nombre of [
      'IMG_20261030_0915.jpg',
      'VID_20261030_0915.mp4',
      'PXL_20261030_091500123.mp4',
      'WhatsApp Audio 2026-10-30 at 09.15.23.opus',
      'img_0001.heic',
      'whatsapp audio 2026.ogg',
    ]) {
      assert.equal(nombrePorDefecto(nombre), '', nombre);
    }
  });

  it('sin nombre, o con solo guiones, no inventa nada', () => {
    assert.equal(nombrePorDefecto(null), '');
    assert.equal(nombrePorDefecto(''), '');
    assert.equal(nombrePorDefecto('---.pdf'), '');
  });

  it('no se pasa del tope del servidor', () => {
    const largo = nombrePorDefecto(`${'a'.repeat(120)}.pdf`);
    assert.equal(largo.length, MAX_TITULO_DE_ADJUNTO);
  });
});

describe('el nombre tal como se guarda', () => {
  it('sin espacios de más; vacío es «sin nombre»', () => {
    assert.equal(limpiarTitulo('  Meditación   de la  mañana '), 'Meditación de la mañana');
    assert.equal(limpiarTitulo('   '), null);
    assert.equal(limpiarTitulo(undefined), null);
    assert.equal(limpiarTitulo('x'.repeat(200))?.length, MAX_TITULO_DE_ADJUNTO);
  });

  it('lo que manda el servidor se lee sin fiarse', () => {
    assert.equal(leerTitulo('Respiración 4-7-8'), 'Respiración 4-7-8');
    assert.equal(leerTitulo(''), null);
    assert.equal(leerTitulo(42), null);
    assert.equal(leerTitulo(undefined), null);
  });

  it('sin el campo, todo audio es nota de voz (una API sin la 0113)', () => {
    assert.equal(leerNotaDeVoz('audio', undefined), true);
    assert.equal(leerNotaDeVoz('audio', null), true);
    assert.equal(leerNotaDeVoz('audio', false), false);
    assert.equal(leerNotaDeVoz('audio', true), true);
    // Solo un audio puede ser nota de voz.
    assert.equal(leerNotaDeVoz('document', true), false);
  });
});

describe('qué se puede nombrar y quién', () => {
  it('audios, documentos y videos sí; una foto no', () => {
    assert.ok(seNombra('audio'));
    assert.ok(seNombra('video'));
    assert.ok(seNombra('document'));
    assert.ok(!seNombra('image'));
  });

  it('el adjunto nombrable de un mensaje es el primero que no es una foto', () => {
    const foto = { id: 'f', kind: 'image' };
    const audio = { id: 'a', kind: 'audio' };
    const pdf = { id: 'p', kind: 'document' };
    assert.equal(adjuntoNombrable([foto, audio, pdf]), audio);
    assert.equal(adjuntoNombrable([foto]), null);
    assert.equal(adjuntoNombrable(undefined), null);
  });

  it('el menú lo ofrece a quien lo envió y a quien administra, nunca sobre una foto', () => {
    const audio = { kind: 'audio' };
    assert.ok(puedeNombrar({ mio: true, administra: false, adjunto: audio }));
    assert.ok(puedeNombrar({ mio: false, administra: true, adjunto: audio }));
    // Un miembro, sobre lo de otro: ni «Ponerle nombre» ni «Cambiar el nombre».
    assert.ok(!puedeNombrar({ mio: false, administra: false, adjunto: audio }));
    assert.ok(!puedeNombrar({ mio: true, administra: true, adjunto: { kind: 'image' } }));
    assert.ok(!puedeNombrar({ mio: true, administra: true, adjunto: null }));
  });

  it('el cuadrito de la tarjeta: micrófono, nota musical, cámara o la sigla', () => {
    assert.equal(iconoDeTarjeta({ kind: 'audio' }), 'mic');
    assert.equal(iconoDeTarjeta({ kind: 'audio', voiceNote: true }), 'mic');
    assert.equal(iconoDeTarjeta({ kind: 'audio', voiceNote: false }), 'music');
    assert.equal(iconoDeTarjeta({ kind: 'video' }), 'video');
    assert.equal(iconoDeTarjeta({ kind: 'document' }), null);
  });
});

describe('un archivo elegido con «Archivo»: audio o documento', () => {
  it('un audio que se sabe reproducir va como audio', () => {
    assert.equal(tipoDeArchivoElegido('audio/mpeg', 'a.mp3'), 'audio');
    assert.equal(tipoDeArchivoElegido('audio/x-m4a', 'a.m4a'), 'audio');
    assert.equal(tipoDeArchivoElegido('audio/wav', 'a.wav'), 'audio');
    assert.equal(tipoDeArchivoElegido('audio/ogg', 'a.ogg'), 'audio');
    assert.equal(tipoDeArchivoElegido('audio/aac', 'a.aac'), 'audio');
  });

  it('sin tipo, o con uno genérico, decide la extensión', () => {
    assert.equal(tipoDeArchivoElegido(null, 'respiracion.mp3'), 'audio');
    assert.equal(tipoDeArchivoElegido('application/octet-stream', 'nota.m4a'), 'audio');
    assert.equal(tipoDeArchivoElegido('application/ogg', 'nota.opus'), 'audio');
    assert.equal(tipoDeArchivoElegido('', 'guia.pdf'), 'document');
  });

  it('otro audio, un PDF o un video siguen siendo documentos', () => {
    assert.equal(tipoDeArchivoElegido('audio/amr', 'nota.amr'), 'document');
    assert.equal(tipoDeArchivoElegido('audio/flac', 'disco.flac'), 'document');
    assert.equal(tipoDeArchivoElegido('application/pdf', 'guia.pdf'), 'document');
    assert.equal(tipoDeArchivoElegido('video/mp4', 'clase.mp4'), 'document');
  });

  it('se eligen hasta diez de una vez', () => {
    assert.equal(MAX_ARCHIVOS_DE_UNA_VEZ, 10);
  });
});

describe('los temas de un mensaje', () => {
  const MED: TemaDeMensaje = { id: 't1', nombre: 'Meditaciones' };
  const RES: TemaDeMensaje = { id: 't2', nombre: 'Respiración' };

  it('se leen sin fiarse: sin repetidos y sin filas a medias', () => {
    assert.deepEqual(
      leerTemasDeMensaje([
        { id: 't1', name: ' Meditaciones ' },
        { id: 't1', name: 'Otra vez' },
        { id: '', name: 'Sin id' },
        { id: 't3' },
        'basura',
        { id: 't2', name: 'Respiración' },
      ]),
      [MED, RES],
    );
    assert.deepEqual(leerTemasDeMensaje(undefined), []);
    assert.deepEqual(leerTemasDeMensaje({ id: 't1' }), []);
  });

  it('la respuesta de `of-messages` es un mapa por mensaje', () => {
    assert.deepEqual(
      leerTemasDeMensajes({ m1: [{ id: 't1', name: 'Meditaciones' }], m2: [], m3: 'x' }),
      { m1: [MED], m2: [], m3: [] },
    );
    assert.deepEqual(leerTemasDeMensajes(null), {});
    assert.deepEqual(leerTemasDeMensajes([]), {});
  });

  it('la etiqueta: nada, el tema, o «En N temas»', () => {
    assert.deepEqual(etiquetaDeTemas(undefined), { tipo: 'ninguna' });
    assert.deepEqual(etiquetaDeTemas([]), { tipo: 'ninguna' });
    assert.deepEqual(etiquetaDeTemas([MED]), { tipo: 'uno', tema: MED });
    assert.deepEqual(etiquetaDeTemas([MED, RES]), { tipo: 'varios', cuantos: 2 });
  });

  it('el texto de la etiqueta y lo que dice el lector de pantalla', () => {
    const con = (texto: string, valores: Record<string, string | number>) =>
      Object.entries(valores).reduce((t, [k, v]) => t.replaceAll(`{${k}}`, String(v)), texto);
    assert.equal(
      con(es['topicChip.oneLabel'], { nombre: 'Meditaciones' }),
      'Está en el tema Meditaciones. Abrir el tema',
    );
    assert.equal(con(es['topicChip.many'], { n: 2 }), 'En 2 temas');
    assert.equal(con(es['topicChip.manyLabel'], { n: 2 }), 'Está en 2 temas. Ver cuáles');
    // El menú del mensaje dice lo mismo con otras palabras.
    assert.equal(con(es['topicChip.goToTopic'], { nombre: 'Meditaciones' }), 'Ir al tema «Meditaciones»');
    assert.equal(es['topicChip.seeTopics'], 'Ver en qué temas está');
  });

  it('refrescar pone los nuevos, quita los que ya no están y no toca lo no preguntado', () => {
    const mensajes = [
      { id: 'm1', temas: [MED] },
      { id: 'm2' },
      { id: 'm3', temas: [RES] },
      { id: 'm4', temas: [MED] },
    ];
    const siguiente = aplicarTemas(mensajes, ['m1', 'm2', 'm3'], { m1: [MED, RES], m2: [RES] });
    assert.deepEqual(siguiente[0]?.temas, [MED, RES]);
    assert.deepEqual(siguiente[1]?.temas, [RES]);
    // Preguntado y no devuelto: ya no está en ninguno.
    assert.equal(siguiente[2]?.temas, undefined);
    // No preguntado: el mismo objeto de antes.
    assert.equal(siguiente[3], mensajes[3]);
  });

  it('si nada cambia devuelve LA MISMA lista: el chat no se repinta', () => {
    const mensajes = [{ id: 'm1', temas: [MED] }, { id: 'm2' }];
    assert.equal(aplicarTemas(mensajes, ['m1', 'm2'], { m1: [{ ...MED }], m2: [] }), mensajes);
    assert.ok(mismosTemas([MED], [{ id: 't1', nombre: 'Meditaciones' }]));
    assert.ok(!mismosTemas([MED], [{ id: 't1', nombre: 'Meditación' }]));
    assert.ok(mismosTemas(undefined, []));
  });

  it('se pregunta por los últimos cien guardados, no por lo que se está enviando', () => {
    const muchos = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}` }));
    const ids = idsParaPreguntarTemas([
      ...muchos,
      { id: 'tmp', estado: 'enviando' },
      { id: 'borrado', eliminado: true },
      { id: 'sesion:1', sesion: {} },
    ]);
    assert.equal(ids.length, MAX_CONSULTA_DE_TEMAS);
    assert.equal(ids[0], 'm30');
    assert.equal(ids.at(-1), 'm129');
  });
});

describe('poner el nombre que guardó el servidor', () => {
  it('cambia solo ese adjunto, y la lista es otra solo si hubo cambio', () => {
    const mensajes = [
      { id: 'm1', attachments: [{ id: 'a1', kind: 'audio', title: null }] },
      { id: 'm2', attachments: [{ id: 'a2', kind: 'document' }] },
    ];
    const siguiente = conTituloDeAdjunto(mensajes, 'a1', 'Meditación de la mañana');
    assert.equal(siguiente[0]?.attachments?.[0]?.title, 'Meditación de la mañana');
    assert.equal(siguiente[1], mensajes[1]);
    assert.equal(conTituloDeAdjunto(mensajes, 'no-esta', 'x'), mensajes);
  });
});

describe('los textos de cada «no» del servidor existen', () => {
  it('el nombre', () => {
    for (const codigo of [
      'attachment_title_forbidden',
      'attachment_not_found',
      'attachment_title_too_long',
      'attachment_title_not_allowed',
      'attachment_titles_not_available',
      'otro',
      null,
    ]) {
      const clave = claveDelFalloDeNombre(codigo);
      assert.ok(clave in es, `${codigo} → ${clave}`);
    }
    assert.notEqual(claveDelFalloDeNombre('attachment_title_forbidden'), claveDelFalloDeNombre(null));
  });

  it('agregar varios: el todo o nada tiene su texto, lo demás es de temas', () => {
    const clave = claveDelFalloDeAgregarVarios('message_not_in_group');
    assert.ok(clave && clave in es);
    assert.equal(claveDelFalloDeAgregarVarios('topic_not_found'), null);
  });
});

describe('lo pequeño', () => {
  it('la duración en palabras: «42 segundos», nunca «0:42» leído en voz alta', () => {
    assert.deepEqual(partesDeDuracion(42), { minutos: 0, segundos: 42 });
    assert.deepEqual(partesDeDuracion(75.4), { minutos: 1, segundos: 15 });
    assert.deepEqual(partesDeDuracion(0.3), { minutos: 0, segundos: 1 });
    assert.equal(partesDeDuracion(0), null);
    assert.equal(partesDeDuracion(null), null);
    assert.equal(partesDeDuracion(Number.NaN), null);
    const etiqueta = es['chat.playNamed']
      .replace('{nombre}', 'Meditación de la mañana')
      .replace('{duracion}', es['chat.spokenSeconds'].replace('{n}', '42'));
    assert.equal(etiqueta, 'Reproducir Meditación de la mañana, 42 segundos');
  });

  it('elegir varios: marca y desmarca sin tocar la lista original', () => {
    const antes = ['a'];
    assert.deepEqual(alternarSeleccion(antes, 'b'), ['a', 'b']);
    assert.deepEqual(alternarSeleccion(antes, 'a'), []);
    assert.deepEqual(antes, ['a']);
  });
});
