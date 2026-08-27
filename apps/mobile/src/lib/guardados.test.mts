import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estadoDeGuardados, filaDeAudio } from './guardados.ts';

/*
  Lo que se fija aqui es lo que estaba mal en las dos pantallas:

  1. Una lista vacia por un fallo de red NO es «no tienes nada guardado».
  2. «Mis Audios» ensena audios GUARDADOS. No hay historial de escucha, y una
     fila sin URL firmada no puede ofrecer un play que no suena.
*/

test('sin respuesta todavia, la lista esta cargando', () => {
  assert.equal(estadoDeGuardados(null, null), 'loading');
});

test('vacia por un fallo es error, no «no tienes nada»', () => {
  // Es la diferencia entre «comprueba tu red» y hacer creer que se perdio lo
  // guardado. Ademas es lo unico que pinta el boton de reintentar.
  assert.equal(estadoDeGuardados([], 'La red no responde.'), 'error');
});

test('vacia sin fallo si es «no tienes nada»', () => {
  assert.equal(estadoDeGuardados([], null), 'empty');
});

test('con filas en pantalla, un fallo posterior no las borra', () => {
  // Fallar al pedir la pagina siguiente no puede vaciar lo ya cargado.
  assert.equal(estadoDeGuardados([{ id: 'a' }], 'La red no responde.'), 'content');
});

const AUDIO = {
  body: 'El poder de la disciplina diaria',
  author: 'Edson',
  mediaUrl: 'https://cdn/firmado/audio.m4a?token=abc',
  mediaDurationS: 754,
};

test('el titulo de un audio es su texto y el detalle lleva autor y duracion', () => {
  const fila = filaDeAudio(AUDIO);
  assert.equal(fila.titulo, 'El poder de la disciplina diaria');
  assert.equal(fila.detalle, 'Edson · 12:34');
  assert.equal(fila.reproducible, true);
});

test('de un texto largo solo se queda la primera linea', () => {
  const fila = filaDeAudio({ ...AUDIO, body: 'Enfoque semanal\n\nY aqui va el resumen.' });
  assert.equal(fila.titulo, 'Enfoque semanal');
});

test('sin texto, el audio se nombra por quien lo publico', () => {
  // Antes que una fila en blanco: la lista tiene que poder senalarse.
  assert.equal(filaDeAudio({ ...AUDIO, body: '   \n ' }).titulo, 'Audio de Edson');
  assert.equal(filaDeAudio({ ...AUDIO, body: '', author: '' }).titulo, 'Audio');
});

test('una duracion desconocida no se inventa como 0:00', () => {
  assert.equal(filaDeAudio({ ...AUDIO, mediaDurationS: undefined }).detalle, 'Edson');
  assert.equal(filaDeAudio({ ...AUDIO, mediaDurationS: 0 }).detalle, 'Edson');
});

test('los segundos van siempre con dos cifras', () => {
  // «5:7» no es una duracion; el reproductor escribe «5:07».
  assert.equal(filaDeAudio({ ...AUDIO, mediaDurationS: 307 }).detalle, 'Edson · 5:07');
});

test('sin URL firmada la fila no ofrece reproduccion', () => {
  // La firma caduca: quien pinta la fila la manda al detalle, que la repide.
  assert.equal(filaDeAudio({ ...AUDIO, mediaUrl: undefined }).reproducible, false);
});
