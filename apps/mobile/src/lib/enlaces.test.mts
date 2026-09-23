/**
 * El bug que fija este fichero, tal como se reporto:
 *
 *   «Los botones de compartir mandan solo texto. Quien recibe el mensaje no
 *   puede llegar al contenido.»
 *
 * Se compartia «Mira este short de Katherine en Z.» y nada mas: ni ruta, ni
 * dominio. Aqui se comprueba que lo que sale del boton lleva SIEMPRE la URL de
 * la publicacion, que el dominio viene de configuracion, y que la pantalla que
 * abre ese enlace sabe pedir la publicacion por su cuenta.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  VARIABLE_DE_LA_WEB,
  baseDeLaWeb,
  compartirPublicacion,
  enlaceDePublicacion,
  textoParaCompartir,
} from './enlaces.ts';

/** Raiz de `apps/mobile`: este fichero vive en `src/lib/`. */
const RAIZ = join(import.meta.dirname, '..', '..');
const leer = (...tramos: string[]) => readFileSync(join(RAIZ, ...tramos), 'utf8');

const ORIGINAL = process.env.EXPO_PUBLIC_WEB_URL;
/** Deja el entorno como estaba: los demas ficheros de prueba comparten proceso. */
const ponerWeb = (valor: string | undefined) => {
  if (valor === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
  else process.env.EXPO_PUBLIC_WEB_URL = valor;
};
after(() => ponerWeb(ORIGINAL));

test('lo compartido lleva una URL, no solo la frase', () => {
  ponerWeb('https://social-media-renaser.vercel.app');
  const { message } = compartirPublicacion({ postId: 'abc-123', autor: 'Katherine' });

  // Esto es exactamente lo que fallaba: habia texto, y se acababa ahi.
  assert.ok(message.includes('https://'), `no hay enlace en el mensaje: ${message}`);
  assert.ok(message.includes('Katherine'), 'se perdio el nombre del autor');
  assert.equal(message, 'Mira esta publicación de Katherine en Z\nhttps://social-media-renaser.vercel.app/post/abc-123');
});

test('la URL apunta a la publicacion que se estaba viendo', () => {
  ponerWeb('https://social-media-renaser.vercel.app');
  const { url } = compartirPublicacion({ postId: 'el-id-de-verdad', autor: 'Katherine' });

  assert.ok(url?.endsWith('/post/el-id-de-verdad'), `id equivocado en ${url}`);
  // Un id de otra publicacion no puede colarse en el enlace.
  assert.equal(url?.includes('otro-id'), false);
});

test('la ruta es /post/{id} para texto, video y audio: todo es una publicacion', () => {
  ponerWeb('https://social-media-renaser.vercel.app');
  const base = 'https://social-media-renaser.vercel.app/post/p1';
  assert.equal(compartirPublicacion({ postId: 'p1' }).url, base);
  assert.equal(compartirPublicacion({ postId: 'p1', clase: 'video' }).url, base);
  assert.equal(compartirPublicacion({ postId: 'p1', clase: 'audio' }).url, base);
});

test('el dominio sale de configuracion, no escrito a fuego', () => {
  ponerWeb('https://otro-dominio.example');
  assert.equal(enlaceDePublicacion('p1'), 'https://otro-dominio.example/post/p1');

  // Y no queda ningun dominio metido a mano en el codigo del ayudante.
  const fuente = leer('src', 'lib', 'enlaces.ts');
  const dominios = fuente.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  assert.deepEqual(dominios, [], `dominio escrito a fuego en enlaces.ts: ${dominios.join(', ')}`);
  assert.ok(fuente.includes('process.env.EXPO_PUBLIC_WEB_URL'));
  assert.equal(VARIABLE_DE_LA_WEB, 'EXPO_PUBLIC_WEB_URL');
});

test('la variable esta en los tres perfiles de eas.json y en .env.example', () => {
  const eas = JSON.parse(leer('eas.json')) as {
    build: Record<string, { env?: Record<string, string> }>;
  };
  for (const perfil of ['development', 'preview', 'production']) {
    const valor = eas.build[perfil]?.env?.EXPO_PUBLIC_WEB_URL;
    assert.ok(valor, `falta EXPO_PUBLIC_WEB_URL en el perfil ${perfil}`);
    assert.ok(valor.startsWith('https://'), `el perfil ${perfil} no usa HTTPS: ${valor}`);
  }
  assert.ok(leer('.env.example').includes('EXPO_PUBLIC_WEB_URL=https://'));

  // EL `.env` SOLO SI EXISTE, y no es una rebaja.
  //
  // `.env` no esta versionado —lleva valores de cada quien— asi que en la
  // integracion continua NO EXISTE, y exigirlo hacia que esta prueba fallara
  // alli con un ENOENT que no habla de enlaces ni de perfiles. No se vio
  // durante meses porque las baterias del movil no se ejecutaban en ningun
  // trabajo.
  //
  // Lo que se comprueba de verdad es `eas.json` y `.env.example`, que si estan
  // versionados y son el contrato. El `.env` local se revisa cuando lo hay,
  // que es donde ese aviso le sirve a alguien.
  if (existsSync(join(RAIZ, '.env'))) {
    assert.ok(
      leer('.env').includes('EXPO_PUBLIC_WEB_URL=https://'),
      'tu .env local no define EXPO_PUBLIC_WEB_URL con https',
    );
  }
});

test('sin HTTPS no se comparte enlace: una URL rota es peor que solo texto', () => {
  // Un `http://` o un `localhost` parecen un enlace y no abren nada en el
  // telefono de otra persona. Se prefiere quedarse en la frase.
  for (const malo of ['http://social-media-renaser.vercel.app', 'http://localhost:8081', 'https://', '  ', 'social-media-renaser.vercel.app']) {
    ponerWeb(malo);
    assert.equal(baseDeLaWeb(), null, `deberia rechazar ${malo}`);
    const { message, url } = compartirPublicacion({ postId: 'p1', autor: 'Katherine' });
    assert.equal(url, null);
    assert.equal(message, 'Mira esta publicación de Katherine en Z');
    assert.equal(message.includes('http'), false, 'se colo media URL en el texto');
  }

  ponerWeb(undefined);
  assert.equal(baseDeLaWeb(), null);
  assert.equal(enlaceDePublicacion('p1'), null);
});

test('sin id no hay enlace, y sin autor la frase sigue leyendose bien', () => {
  ponerWeb('https://social-media-renaser.vercel.app');
  assert.equal(enlaceDePublicacion(null), null);
  assert.equal(enlaceDePublicacion(''), null);

  // Degradar con dignidad: nunca «de undefined» ni un nombre inventado.
  assert.equal(textoParaCompartir('publicacion', null), 'Mira esta publicación en Z');
  assert.equal(textoParaCompartir('video', '   '), 'Mira este vídeo en Z');
  assert.equal(textoParaCompartir('audio', undefined), 'Escucha este audio en Z');
});

test('un id con caracteres raros no rompe la URL', () => {
  ponerWeb('https://social-media-renaser.vercel.app');
  assert.equal(
    enlaceDePublicacion('a b/c?d'),
    'https://social-media-renaser.vercel.app/post/a%20b%2Fc%3Fd',
  );
});

test('los tres botones de compartir usan el mismo ayudante', () => {
  // Si alguien vuelve a construir la URL dentro del componente, la siguiente
  // correccion se aplicaria solo a dos de los tres sitios.
  for (const ruta of [
    ['src', 'components', 'PostCard.tsx'],
    ['src', 'components', 'ShortVideoItem.tsx'],
    ['src', 'screens', 'AudioScreen.tsx'],
  ]) {
    const fuente = leer(...ruta);
    assert.ok(
      fuente.includes("from '@/lib/enlaces'"),
      `${ruta.join('/')} no usa el ayudante de enlaces`,
    );
    assert.ok(fuente.includes('compartirPublicacion('), `${ruta.join('/')} no comparte con enlace`);
    // Ningun dominio absoluto en el componente. Las rutas relativas del
    // `router.push('/post/…')` son navegacion dentro de la app, no enlaces.
    assert.equal(
      fuente.includes('https://'),
      false,
      `${ruta.join('/')} vuelve a montar la URL por su cuenta`,
    );
  }
});

test('una publicacion compartida abre con el feed vacio', () => {
  /*
    El enlace se abre en una app recien arrancada: `state.posts` esta vacio. La
    pantalla de detalle tiene que PEDIR la publicacion por su id; si solo mira
    la lista en memoria, un enlace perfectamente valido responde «no
    disponible».
  */
  const fuente = leer('src', 'screens', 'PostDetailScreen.tsx');
  assert.ok(
    fuente.includes('PostRepository.getById'),
    'PostDetailScreen no pide la publicacion al servidor: depende del feed',
  );
  assert.ok(fuente.includes('useLocalSearchParams'), 'no lee el id de la ruta');
  // Y la ruta existe y monta esa pantalla.
  assert.ok(leer('app', 'post', '[id].tsx').includes('PostDetailScreen'));

  const repo = leer('src', 'repositories', 'PostRepository.ts');
  assert.ok(/posts\/\$\{encodeURIComponent\(postId\)\}/.test(repo), 'getById no consulta por id');
});

test('la ruta de short de demostracion no ha vuelto', () => {
  // Traia un video de «Darren» con 142 me gusta inventados y era alcanzable en
  // produccion. El feed de shorts real es `components/ShortVideoItem`.
  assert.equal(existsSync(join(RAIZ, 'app', 'short')), false, 'volvio la ruta /short');
  assert.equal(
    existsSync(join(RAIZ, 'src', 'screens', 'ShortVideoScreen.tsx')),
    false,
    'volvio ShortVideoScreen',
  );
  const rutas = readdirSync(join(RAIZ, 'app'), { recursive: true }) as string[];
  const sospechosas = rutas.filter((r) => /(^|[\\/])short/i.test(String(r)));
  assert.deepEqual(sospechosas, [], `rutas de short reintroducidas: ${sospechosas.join(', ')}`);
});

test('el catch-all de vercel.json sostiene las rutas profundas al recargar', () => {
  // Sin el, recargar el navegador en /post/{id} pide un fichero que no existe
  // en `dist` y devuelve 404 antes de que la app llegue a arrancar.
  const vercel = JSON.parse(leer('..', '..', 'vercel.json')) as {
    rewrites: { source: string; destination: string }[];
  };
  const ultimo = vercel.rewrites[vercel.rewrites.length - 1];
  assert.equal(ultimo.source, '/(.*)');
  assert.equal(ultimo.destination, '/index.html');
});
