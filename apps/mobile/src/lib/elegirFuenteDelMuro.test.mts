import assert from 'node:assert/strict';
import test from 'node:test';

import { elegirFuenteDelMuro, elegirFuenteDeVideo, esMp4DelFeed } from './elegirFuenteDeVideo.ts';

/*
  EL VIDEO «LANDING» (24/11/2026). En el muro, un HLS de Supabase tardaba
  2-4 s en arrancar (dos listas por la API y el primer segmento fuera de la
  cache del CDN) y no entraba en la cache de disco. Su MP4 del feed da el
  primer mega en 0,2 s y se queda en disco.
*/
const HLS = 'https://api.example/api/v1/media/770d/hls/master.m3u8';
const FEED = 'https://sb.example/storage/v1/object/sign/post-media/u/derived/770d/feed.mp4?token=x';

test('reconoce el MP4 del feed en Supabase y en S3, y no el original', () => {
  assert.equal(esMp4DelFeed('u/derived/770d/feed.mp4'), true);
  assert.equal(esMp4DelFeed('videos/u/m/feed-720-v1.mp4'), true);
  assert.equal(esMp4DelFeed('u/1784669750614-6nf1ljmb.mp4'), false);
  assert.equal(esMp4DelFeed('videos/u/m/original.mp4'), false);
  assert.equal(esMp4DelFeed(undefined), false);
});

test('en el muro, con MP4 del feed, se reproduce el MP4 y no el HLS', () => {
  const post = { streamUrl: HLS, mediaUrl: FEED, mediaPath: 'u/derived/770d/feed.mp4' };
  assert.deepEqual(elegirFuenteDelMuro(post, true), { uri: FEED, isStream: false });
  // Fuera del muro, lo de siempre.
  assert.deepEqual(elegirFuenteDeVideo(post, true), { uri: HLS, isStream: true });
});

test('si lo unico que hay es el original, el muro sigue con el HLS', () => {
  // El original puede no estar intercalado ni tener el moov delante.
  const post = { streamUrl: HLS, mediaUrl: 'https://x/original.mp4', mediaPath: 'u/1784-abc.mp4' };
  assert.deepEqual(elegirFuenteDelMuro(post, true), { uri: HLS, isStream: true });
});

test('sin HLS o en la web no cambia nada', () => {
  const sinHls = { mediaUrl: FEED, mediaPath: 'u/derived/770d/feed.mp4' };
  assert.deepEqual(elegirFuenteDelMuro(sinHls, true), { uri: FEED, isStream: false });
  const conHls = { streamUrl: HLS, mediaUrl: FEED, mediaPath: 'u/derived/770d/feed.mp4' };
  assert.deepEqual(elegirFuenteDelMuro(conHls, false), { uri: FEED, isStream: false });
});
