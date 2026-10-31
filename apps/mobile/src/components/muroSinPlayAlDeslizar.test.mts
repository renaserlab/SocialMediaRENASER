import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EL MURO DE VIDEOS NO ENSEÑA EL PLAY AL DESLIZAR.
 *
 * LO QUE SE REPORTO (31/10): al pasar de un video al siguiente en Inicio salía
 * primero un círculo de play enorme, y no se sentía fluido como TikTok.
 *
 * LA CAUSA: `FeedVerticalDeVideos` monta el SIGUIENTE video de antemano
 * (`preload`) para que no haya tirón, pero `ShortVideoItem` no le pedía a
 * `VideoPlayer` que escondiera el círculo. Un reproductor montado y aún sin
 * arrancar pintaba su portada con el botón de play encima, y el activo lo
 * volvía a enseñar mientras cargaba. `PostCard` ya lo hacía bien
 * (`hidePlayButton={autoFeed}`), pero en los videos de Inicio se había quedado
 * fuera.
 *
 * Se mira el CÓDIGO FUENTE, como el resto de pruebas de esta carpeta.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const leer = (archivo: string) => readFileSync(join(CARPETA, archivo), 'utf8');

test('el video del muro de Inicio esconde el play mientras se prepara', () => {
  const fuente = leer('ShortVideoItem.tsx');
  const reproductor = fuente.slice(fuente.indexOf('<VideoPlayer'), fuente.indexOf('/>', fuente.indexOf('<VideoPlayer')));
  assert.ok(reproductor.length > 0, 'ShortVideoItem tiene que pintar un VideoPlayer');
  assert.match(reproductor, /\bhidePlayButton\b(?!\s*=\s*\{\s*false)/, 'el muro reproduce solo: pasa hidePlayButton');
  assert.match(reproductor, /\bactive=\{active\}/, 'solo el video que se ve se reproduce');
});

test('con hidePlayButton, un video sin arrancar solo enseña la portada y el play vuelve solo tras pausar', () => {
  const fuente = leer('VideoPlayer.tsx');
  assert.match(fuente, /\{!started && hidePlayButton \? \(/, 'sin arrancar: solo portada, sin botón');
  assert.match(fuente, /!playing && \(!hidePlayButton \|\| userPaused\)/, 'el círculo vuelve solo si la persona pausa');
});
