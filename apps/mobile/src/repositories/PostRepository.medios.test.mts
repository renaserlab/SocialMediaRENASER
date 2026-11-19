/**
 * Publicaciones con videos en S3 (opcion B) de punta a punta dentro del
 * telefono: del JSON de la API a la URL que se reproduce, pasando por la fase
 * de firmas. Con la API y Supabase de mentira, que apuntan lo que se les pide.
 *
 * Lo que aqui no puede romperse sin que nadie se entere:
 *  - una fila `s3` usa `media_url`/`poster_url`/`stream_url` y NO pide ni una
 *    firma a Supabase;
 *  - una fila de Supabase, o de un servidor viejo sin `almacen`, se mapea y se
 *    firma EXACTAMENTE como antes;
 *  - lo vencido se vuelve a pedir con `GET /posts?ids=` y sin nada vencido no
 *    se pide nada;
 *  - publicar un video de S3 manda `id_de_subida` y no `storage_path`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, it } from 'node:test';

type Peticion = { ruta: string; opciones?: { method?: string; body?: string } };
const peticiones: Peticion[] = [];
const firmas: string[][] = [];
let responder: (p: Peticion) => unknown = () => [];

const g = globalThis as Record<string, unknown>;
g.__api = (ruta: string, opciones?: Peticion['opciones']) => {
  const p = { ruta, opciones };
  peticiones.push(p);
  return Promise.resolve(responder(p));
};
g.__firmar = (rutas: string[]) => {
  firmas.push(rutas);
  return Promise.resolve(Object.fromEntries(rutas.map((r) => [r, `https://supabase/firmada/${r}?token`])));
};

/*
  El repositorio arrastra el cliente HTTP, Supabase y React Native. Aqui se
  sustituyen por piezas de prueba; los modulos de la logica nueva (mapper,
  `mediosS3`, `urlsDeMedios`) son los de verdad. Maquinaria de la prueba, no
  del producto.
*/
const js = (codigo: string) => 'data:text/javascript,' + encodeURIComponent(codigo);
const FALSOS: Record<string, string> = {
  '@/services/api': js(
    "export const API_V1 = '/api/v1'; export const API_BASE_URL = 'https://api.ejemplo.pe';" +
      'export function apiRequest(r, o) { return globalThis.__api(r, o); }',
  ),
  '@/services/storage': js(
    'export function signMediaUrls(r) { return globalThis.__firmar(r); }' +
      'export function profileImageUrl() { return undefined; }',
  ),
  '@/i18n': js("export function traduceEnElIdiomaActual(k) { return k; }"),
  '@/data/categories': js("export const PRIVATE_AUDIO_CATEGORY = 'privado';"),
  '@/mappers/profileMapper': js('export function toProfileSummary(x) { return x; }'),
  // La rama de telemetria (`feature/medicion-video-en-telefono`) hace que
  // `PostRepository.ts` importe este modulo, que arrastra react-native. Se
  // simula YA para que el merge no rompa esta bateria; mientras el modulo no
  // exista en esta rama, la entrada no se usa y no estorba.
  '@/lib/medicionDeVideoEnApp': js('export const medicionDeVideo = { hito() {} };'),
};
const SRC = fileURLToPath(new URL('..', import.meta.url));

registerHooks({
  resolve(especificador, contexto, siguiente) {
    const falso = FALSOS[especificador];
    if (falso) return { url: falso, shortCircuit: true };
    if (especificador.startsWith('@/')) {
      return { url: pathToFileURL(`${SRC}${especificador.slice(2)}.ts`).href, shortCircuit: true };
    }
    return siguiente(especificador, contexto);
  },
});

const { PostRepository, resolveMediaUrls } = await import('./PostRepository.ts');
const { toPost } = await import('../mappers/postMapper.ts');

const ENTRA_EN_6H = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
const VENCIDA = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();

function dto(id: string, medio: Record<string, unknown>) {
  return {
    id,
    author: { id: 'autor', full_name: 'Ana', username: 'ana', avatar_path: null },
    body: '',
    status: 'published',
    visibility: 'public',
    created_at: '2026-11-19T10:00:00Z',
    media: [{ id: `m-${id}`, media_type: 'video', sort_order: 0, ...medio }],
    likes_count: 0,
    comments_count: 0,
    liked_by_me: false,
    saved_by_me: false,
  };
}

const s3 = (id: string, expira = ENTRA_EN_6H, lote = 1) =>
  dto(id, {
    almacen: 's3',
    storage_path: `videos/u1/m-${id}/original.mp4`,
    feed_path: `videos/u1/m-${id}/feed-720-v1.mp4`,
    poster_path: `videos/u1/m-${id}/poster-v1.jpg`,
    stream_path: `videos/u1/m-${id}/hls-v1/master.m3u8`,
    media_url: `https://cdn.ejemplo.pe/videos/u1/m-${id}/feed-720-v1.mp4?lote=${lote}`,
    poster_url: `https://cdn.ejemplo.pe/videos/u1/m-${id}/poster-v1.jpg?lote=${lote}`,
    stream_url: `/api/v1/media/m-${id}/hls/master.m3u8?t=lote${lote}`,
    urls_expiran: expira,
  });

const supabase = (id: string, almacen?: 'supabase') =>
  dto(id, {
    ...(almacen ? { almacen } : {}),
    storage_path: `u1/${id}.mp4`,
    feed_path: `u1/derived/m-${id}/feed.mp4`,
    poster_path: `u1/derived/m-${id}/poster.jpg`,
    stream_path: `u1/derived/m-${id}/hls/master.m3u8`,
  });

beforeEach(() => {
  peticiones.length = 0;
  firmas.length = 0;
  responder = () => [];
});

describe('del JSON de la API al modelo de vista', () => {
  it('una fila s3 lleva las URLs de la API, el HLS con su token y la portada por clave', () => {
    const post = toPost(s3('a'));
    assert.equal(post.mediaAlmacen, 's3');
    assert.equal(post.mediaUrl, 'https://cdn.ejemplo.pe/videos/u1/m-a/feed-720-v1.mp4?lote=1');
    assert.equal(post.posterUrl, 'https://cdn.ejemplo.pe/videos/u1/m-a/poster-v1.jpg?lote=1');
    assert.equal(post.streamUrl, 'https://api.ejemplo.pe/api/v1/media/m-a/hls/master.m3u8?t=lote1');
    // Clave de cache del poster: estable, sin query.
    assert.equal(post.posterPath, 'videos/u1/m-a/poster-v1.jpg');
    assert.equal(post.urlsExpiran, ENTRA_EN_6H);
  });

  it('una fila s3 sin HLS no se queda con el HLS armado a mano (sin token no abre)', () => {
    const sinHls = s3('b');
    sinHls.media[0] = { ...sinHls.media[0], stream_url: null } as (typeof sinHls.media)[0];
    assert.equal(toPost(sinHls).streamUrl, undefined);
  });

  it('rama vieja: Supabase, con o sin `almacen`, se mapea igual que siempre', () => {
    for (const fila of [supabase('c'), supabase('c', 'supabase')]) {
      const post = toPost(fila);
      assert.equal(post.mediaAlmacen, 'supabase');
      assert.equal(post.mediaUrl, undefined);
      assert.equal(post.mediaPath, 'u1/derived/m-c/feed.mp4');
      assert.equal(post.posterPath, 'u1/derived/m-c/poster.jpg');
      assert.equal(post.streamUrl, 'https://api.ejemplo.pe/api/v1/media/m-c/hls/master.m3u8');
      assert.equal(post.urlsExpiran, undefined);
      assert.equal('urlsExpiran' in post, false, 'ni siquiera aparece la clave');
    }
  });
});

describe('la fase de firmas', () => {
  it('firma solo lo de Supabase; lo de S3 ni se menciona y conserva sus URLs', async () => {
    const [a, c] = await resolveMediaUrls([toPost(s3('a')), toPost(supabase('c'))]);
    assert.deepEqual(firmas, [['u1/derived/m-c/feed.mp4', 'u1/derived/m-c/poster.jpg']]);
    assert.equal(a?.mediaUrl, 'https://cdn.ejemplo.pe/videos/u1/m-a/feed-720-v1.mp4?lote=1');
    assert.equal(c?.mediaUrl, 'https://supabase/firmada/u1/derived/m-c/feed.mp4?token');
    assert.equal(peticiones.length, 0, 'nada vencido: ni una peticion a la API');
  });

  it('solo S3 y al dia: ni firmas ni peticiones', async () => {
    const lista = [toPost(s3('a')), toPost(s3('b'))];
    const salida = await resolveMediaUrls(lista);
    assert.deepEqual(firmas, []);
    assert.equal(peticiones.length, 0);
    assert.deepEqual(salida, lista);
  });

  it('lo vencido se vuelve a pedir con `GET /posts?ids=` y se reemplaza', async () => {
    responder = (p) => (p.ruta.includes('ids=') ? [s3('a', ENTRA_EN_6H, 2)] : []);
    const viejo = { ...toPost(s3('a', VENCIDA)), likes: 7 };
    const [renovado, intacto] = await resolveMediaUrls([viejo, toPost(s3('b'))]);
    assert.deepEqual(
      peticiones.map((p) => decodeURIComponent(p.ruta)),
      ['/api/v1/posts?ids=a'],
    );
    assert.equal(renovado?.mediaUrl, 'https://cdn.ejemplo.pe/videos/u1/m-a/feed-720-v1.mp4?lote=2');
    assert.equal(renovado?.streamUrl, 'https://api.ejemplo.pe/api/v1/media/m-a/hls/master.m3u8?t=lote2');
    assert.equal(renovado?.urlsExpiran, ENTRA_EN_6H);
    assert.equal(renovado?.likes, 7, 'lo demas de la publicacion no se pisa');
    assert.equal(intacto?.mediaUrl, 'https://cdn.ejemplo.pe/videos/u1/m-b/feed-720-v1.mp4?lote=1');
    assert.deepEqual(firmas, []);
  });

  it('la instantanea del muro (sin URLs) recupera las de S3 pidiendolas, no firmando', async () => {
    responder = () => [s3('a')];
    const sinUrls = { ...toPost(s3('a')), mediaUrl: undefined, posterUrl: undefined };
    const [post] = await resolveMediaUrls([sinUrls]);
    assert.equal(peticiones.length, 1);
    assert.deepEqual(firmas, []);
    assert.equal(post?.mediaUrl, 'https://cdn.ejemplo.pe/videos/u1/m-a/feed-720-v1.mp4?lote=1');
  });

  it('sin red se queda lo que habia, sin romper', async () => {
    responder = () => {
      throw new Error('sin cobertura');
    };
    const original = console.warn;
    console.warn = () => {};
    try {
      const viejo = toPost(s3('a', VENCIDA));
      const [post] = await resolveMediaUrls([viejo]);
      assert.equal(post?.mediaUrl, viejo.mediaUrl);
    } finally {
      console.warn = original;
    }
  });
});

describe('publicar y editar', () => {
  it('un video de S3 viaja por `id_de_subida`; una foto, por su ruta como siempre', async () => {
    responder = () => supabase('nuevo');
    await PostRepository.createPost('hola', [
      { storagePath: '', mediaType: 'video', bytes: 10, idDeSubida: 'sub-v', idDeSubidaPoster: 'sub-p' },
    ]);
    await PostRepository.updatePost('nuevo', {
      media: [{ storagePath: 'u1/foto.jpg', mediaType: 'image', width: 3, height: 4 }],
    });
    const [crear, editar] = peticiones;
    assert.equal(crear?.opciones?.method, 'POST');
    assert.deepEqual(JSON.parse(crear?.opciones?.body ?? '{}').media, [
      {
        media_type: 'video',
        id_de_subida: 'sub-v',
        id_de_subida_poster: 'sub-p',
        width: null,
        height: null,
        duration_s: null,
        bytes: 10,
      },
    ]);
    assert.equal(editar?.opciones?.method, 'PATCH');
    assert.deepEqual(JSON.parse(editar?.opciones?.body ?? '{}').media, [
      {
        storage_path: 'u1/foto.jpg',
        media_type: 'image',
        width: 3,
        height: 4,
        duration_s: null,
        bytes: null,
        poster_path: null,
      },
    ]);
  });
});

describe('ultimo cerrojo antes de Supabase', () => {
  it('`signMediaUrls` descarta las claves de S3 antes de la cache y de la red', () => {
    const fuente = readFileSync(fileURLToPath(new URL('../services/storage.ts', import.meta.url)), 'utf8');
    const cuerpo = fuente.slice(fuente.indexOf('export async function signMediaUrls'));
    const filtro = cuerpo.indexOf('!esClaveDeS3(ruta)');
    assert.ok(filtro > 0, 'signMediaUrls tiene que filtrar las claves de S3');
    assert.ok(filtro < cuerpo.indexOf('ensureSignedCacheLoaded()'), 'antes de leer la cache');
    assert.ok(filtro < cuerpo.indexOf('createSignedUrls'), 'antes de pedir firmas');
  });
});
