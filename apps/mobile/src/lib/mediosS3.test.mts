/**
 * Videos en S3 (opcion B), vistos desde la lectura: que se firma, que no, y
 * que URL se reproduce.
 *
 * Lo que aqui no puede romperse sin que nadie se entere:
 *  - una fila `s3` usa las URLs de la API y NO pide firma a Supabase (sus
 *    rutas son claves de S3: Supabase contestaria error);
 *  - la portada de S3 se cachea por su clave SIN query (si la firma se cuela
 *    en la clave, cada refirma vuelve a descargar la imagen);
 *  - una fila de Supabase, o de un servidor viejo sin `almacen`, sigue
 *    EXACTAMENTE igual que antes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aplicarFirmas,
  camposDeS3,
  claveSinQuery,
  cuerpoDeMedio,
  esClaveDeS3,
  resolverStreamUrl,
  rutasParaFirmar,
} from './mediosS3.ts';
import { elegirFuenteDeVideo } from './elegirFuenteDeVideo.ts';

const API = 'https://api.ejemplo.pe';

const filaS3 = {
  almacen: 's3' as const,
  poster_path: 'videos/u1/m1/poster-v1.jpg',
  media_url: 'https://cdn.ejemplo.pe/videos/u1/m1/feed-720-v1.mp4?Policy=a&Signature=b',
  poster_url: 'https://cdn.ejemplo.pe/videos/u1/m1/poster-v1.jpg?Policy=a&Signature=b',
  stream_url: '/api/v1/media/m1/hls/master.m3u8?t=token',
  urls_expiran: '2026-11-19T18:00:00Z',
};

describe('campos de una fila s3', () => {
  it('usa las URLs de la API y resuelve el HLS relativo contra la base de la API', () => {
    assert.deepEqual(camposDeS3(filaS3, `${API}/`), {
      mediaUrl: filaS3.media_url,
      posterUrl: filaS3.poster_url,
      posterPath: 'videos/u1/m1/poster-v1.jpg',
      streamUrl: `${API}/api/v1/media/m1/hls/master.m3u8?t=token`,
      urlsExpiran: '2026-11-19T18:00:00Z',
    });
  });

  it('pone las cinco claves aunque falten: tienen que pisar el HLS armado para Supabase', () => {
    const campos = camposDeS3({ almacen: 's3', media_url: 'https://cdn/x.mp4' }, API);
    assert.ok('streamUrl' in campos);
    assert.equal(campos.streamUrl, undefined);
    // Y al propagarlo encima, el HLS sin token desaparece.
    const post = { streamUrl: `${API}/api/v1/media/m1/hls/master.m3u8`, ...campos };
    assert.equal(post.streamUrl, undefined);
  });

  it('una fila de Supabase, o sin `almacen` (servidor viejo), no aporta nada', () => {
    assert.deepEqual(camposDeS3({ almacen: 'supabase', media_url: 'x' }, API), {});
    assert.deepEqual(camposDeS3({}, API), {});
    assert.deepEqual(camposDeS3(null, API), {});
  });

  it('la clave de cache del poster va sin query', () => {
    assert.equal(claveSinQuery('videos/u1/m1/poster-v1.jpg?X-Amz-Signature=1'), 'videos/u1/m1/poster-v1.jpg');
    assert.equal(claveSinQuery('videos/u1/m1/poster-v1.jpg'), 'videos/u1/m1/poster-v1.jpg');
    assert.equal(claveSinQuery(null), undefined);
    assert.equal(
      camposDeS3({ ...filaS3, poster_path: 'videos/u1/m1/poster-v1.jpg?firma=x' }, API).posterPath,
      'videos/u1/m1/poster-v1.jpg',
    );
  });

  it('el HLS absoluto se respeta; uno raro se descarta (y se usara el MP4)', () => {
    assert.equal(resolverStreamUrl('https://cdn/x.m3u8', API), 'https://cdn/x.m3u8');
    assert.equal(resolverStreamUrl('ftp://x', API), undefined);
    assert.equal(resolverStreamUrl('relativa/sin/barra', API), undefined);
    assert.equal(resolverStreamUrl(null, API), undefined);
  });

  it('reconoce las claves de S3 y no confunde las rutas de Supabase (empiezan por el uid)', () => {
    assert.equal(esClaveDeS3('videos/u1/m1/original.mp4'), true);
    assert.equal(esClaveDeS3('pendientes/u1/abc'), true);
    assert.equal(esClaveDeS3('7d3c0a2e-1111-4222-8333-944445555666/1700-abc.mp4'), false);
    assert.equal(esClaveDeS3('7d3c0a2e-1111-4222-8333-944445555666/derived/m1/poster.jpg'), false);
  });
});

describe('que se firma en Supabase', () => {
  const supabase = { id: 'a', mediaPath: 'u1/video.mp4', posterPath: 'u1/poster.jpg' };
  const s3 = {
    id: 'b',
    mediaAlmacen: 's3' as const,
    mediaPath: 'videos/u2/m2/feed-720-v1.mp4',
    posterPath: 'videos/u2/m2/poster-v1.jpg',
    mediaUrl: 'https://cdn/feed.mp4?firma',
    posterUrl: 'https://cdn/poster.jpg?firma',
  };

  it('las filas s3 no aportan rutas; las de Supabase, como siempre y sin repetir', () => {
    assert.deepEqual(rutasParaFirmar([supabase, s3, { ...supabase, id: 'c' }]), [
      'u1/video.mp4',
      'u1/poster.jpg',
    ]);
    assert.deepEqual(rutasParaFirmar([s3]), []);
  });

  it('las firmas no tocan una fila s3 (mismo objeto, sus URLs intactas)', () => {
    const urls = {
      'u1/video.mp4': 'https://supabase/v?token',
      'u1/poster.jpg': 'https://supabase/p?token',
      // Aunque alguien firmara su clave, no se usa.
      'videos/u2/m2/feed-720-v1.mp4': 'https://supabase/MAL',
    };
    const [a, b] = aplicarFirmas([supabase, s3], urls);
    assert.equal(b, s3);
    assert.equal(b?.mediaUrl, 'https://cdn/feed.mp4?firma');
    assert.deepEqual(a, { ...supabase, mediaUrl: 'https://supabase/v?token', posterUrl: 'https://supabase/p?token' });
  });

  it('rama vieja intacta: sin firma se conserva lo anterior y sin nada que poner, el mismo objeto', () => {
    const conAnterior = { ...supabase, mediaUrl: 'vieja', posterUrl: 'vieja-p' };
    assert.deepEqual(aplicarFirmas([conAnterior], { 'u1/poster.jpg': 'nueva-p' })[0], {
      ...conAnterior,
      posterUrl: 'nueva-p',
    });
    assert.equal(aplicarFirmas([conAnterior], {})[0], conAnterior);
  });
});

describe('que URL se reproduce', () => {
  it('en nativo, el HLS de la API; sin HLS o en web, el MP4 de la API', () => {
    const conHls = { streamUrl: `${API}/api/v1/media/m1/hls/master.m3u8?t=x`, mediaUrl: filaS3.media_url };
    assert.deepEqual(elegirFuenteDeVideo(conHls, true), { uri: conHls.streamUrl, isStream: true });
    assert.deepEqual(elegirFuenteDeVideo(conHls, false), { uri: filaS3.media_url, isStream: false });
    assert.deepEqual(elegirFuenteDeVideo({ mediaUrl: filaS3.media_url }, true), {
      uri: filaS3.media_url,
      isStream: false,
    });
    assert.equal(elegirFuenteDeVideo({}, true), null);
  });
});

describe('lo que viaja al publicar', () => {
  it('un video de S3 va por `id_de_subida`, SIN ruta', () => {
    const cuerpo = cuerpoDeMedio({
      storagePath: '',
      mediaType: 'video',
      width: 720,
      height: 1280,
      durationS: 12,
      bytes: 9_000_000,
      idDeSubida: 'sub-1',
      idDeSubidaPoster: 'sub-2',
    });
    assert.deepEqual(cuerpo, {
      media_type: 'video',
      id_de_subida: 'sub-1',
      id_de_subida_poster: 'sub-2',
      width: 720,
      height: 1280,
      duration_s: 12,
      bytes: 9_000_000,
    });
    assert.equal('storage_path' in cuerpo, false);
    assert.equal('poster_path' in cuerpo, false);
    assert.equal('id_de_subida_poster' in cuerpoDeMedio({ storagePath: '', mediaType: 'video', idDeSubida: 's' }), false);
  });

  it('lo de Supabase, exactamente como antes (y conservar un video s3 es reenviar su clave)', () => {
    assert.deepEqual(
      cuerpoDeMedio({ storagePath: 'u1/v.mp4', mediaType: 'video', bytes: 5, posterPath: 'u1/p.jpg' }),
      {
        storage_path: 'u1/v.mp4',
        media_type: 'video',
        width: null,
        height: null,
        duration_s: null,
        bytes: 5,
        poster_path: 'u1/p.jpg',
      },
    );
  });
});
