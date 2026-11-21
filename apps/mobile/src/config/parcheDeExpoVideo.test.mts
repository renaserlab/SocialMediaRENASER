/**
 * El parche de `expo-video` tiene que existir, casar con la version instalada
 * y aplicarse limpio.
 *
 * POR QUE EXISTE EL PARCHE. La precarga del primer MB de los videos
 * siguientes (`services/precargaDeVideos.ts`) solo sirve si escribe en la
 * MISMA cache de disco que lee el reproductor, y esa cache es interna de
 * expo-video: un fetch desde JS no la llena. El parche anade
 * `precargarVideoAsync`, `cancelarPrecargaDeVideo` y `cancelarPrecargasDeVideo`
 * al modulo `ExpoVideo`, en Android (mismo `SimpleCache`, misma clave) y en iOS
 * (mismos archivos que lee el `ResourceLoaderDelegate`).
 *
 * POR QUE ESTA PRUEBA. patch-package busca el parche por el nombre del
 * fichero (`expo-video+<version>.patch`). Si alguien sube expo-video sin
 * rehacerlo, la precarga desaparece en silencio en la siguiente compilacion
 * (el JS se queda en no-op y nadie lo nota). Aqui falla antes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Raiz del repositorio: este fichero vive en `apps/mobile/src/config/`. */
const RAIZ = join(import.meta.dirname, '..', '..', '..', '..');
const leerJson = <T,>(nombre: string): T =>
  JSON.parse(readFileSync(join(RAIZ, nombre), 'utf8')) as T;

const CARPETA_DE_PARCHES = join(RAIZ, 'patches');
const parchesDeExpoVideo = (): string[] =>
  existsSync(CARPETA_DE_PARCHES)
    ? readdirSync(CARPETA_DE_PARCHES).filter((f) => /^expo-video\+.+\.patch$/.test(f))
    : [];
const contenido = (): string => {
  const [parche] = parchesDeExpoVideo();
  assert.ok(parche, 'no hay parche de expo-video');
  return readFileSync(join(CARPETA_DE_PARCHES, parche), 'utf8');
};

test('hay exactamente un parche de expo-video', () => {
  assert.equal(parchesDeExpoVideo().length, 1, `parches encontrados: ${parchesDeExpoVideo().join(', ')}`);
});

test('el parche es para la version de expo-video que fija el package-lock', () => {
  const bloqueo = leerJson<{ packages: Record<string, { version?: string }> }>('package-lock.json');
  const instalada = bloqueo.packages['node_modules/expo-video']?.version;
  assert.ok(instalada, 'expo-video no aparece en node_modules/ del package-lock raiz');
  const version = parchesDeExpoVideo()[0]?.match(/^expo-video\+(.+)\.patch$/)?.[1];
  assert.equal(version, instalada, 'Se cambio la version de expo-video: hay que rehacer el parche.');
});

test('el parche expone las mismas funciones en Android, iOS y el JS', () => {
  const parche = contenido();
  const servicio = readFileSync(join(RAIZ, 'apps/mobile/src/services/precargaDeVideos.ts'), 'utf8');
  for (const nombre of ['precargarVideoAsync', 'cancelarPrecargaDeVideo', 'cancelarPrecargasDeVideo']) {
    assert.match(parche, new RegExp(`b/node_modules/expo-video/android/[^\\n]*VideoModule\\.kt[\\s\\S]*"${nombre}"`));
    assert.match(parche, new RegExp(`b/node_modules/expo-video/ios/VideoModule\\.swift[\\s\\S]*"${nombre}"`));
    assert.match(servicio, new RegExp(`${nombre}:`), `el servicio JS no declara ${nombre}`);
  }
});

test('Android escribe en la cache del reproductor; iOS en sus mismos archivos', () => {
  const parche = contenido();
  // Android: la misma fabrica que usa el reproductor (mismo SimpleCache y clave).
  assert.match(parche, /PrecargadorDeVideos\.kt/);
  assert.match(parche, /buildCacheDataSourceFactory\(context, fuente\)/);
  // iOS: misma ruta (hash de la URL) y mismo sufijo de informacion.
  assert.match(parche, /PrecargadorDeVideos\.swift/);
  assert.match(parche, /VideoAsset\.pathForUrl\(url: url, fileExtension: fileExtension\)/);
  assert.match(parche, /VideoCacheManager\.mediaInfoSuffix/);
});

test('npm install aplica los parches (postinstall con patch-package)', () => {
  const paquete = leerJson<{ scripts?: Record<string, string>; devDependencies?: Record<string, string> }>(
    'package.json',
  );
  assert.equal(paquete.scripts?.postinstall, 'patch-package');
  assert.ok(paquete.devDependencies?.['patch-package'], 'patch-package tiene que estar en devDependencies');
});

/*
  Que se APLICA, no solo que existe. Si `node_modules/expo-video` esta, se
  comprueba que el parche ya esta aplicado (lo normal tras `npm install`) o
  que se aplicaria limpio. Se usa `git apply`, que entiende el formato de
  patch-package, sobre una copia: nunca se toca node_modules.
*/
test('el parche se aplica (o ya esta aplicado) sobre node_modules/expo-video', (t) => {
  const instalado = join(RAIZ, 'node_modules', 'expo-video');
  if (!existsSync(instalado)) {
    t.skip('sin node_modules/expo-video instalado');
    return;
  }
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' });
  if (git('--version').status !== 0) {
    t.skip('git no disponible');
    return;
  }
  const [parche] = parchesDeExpoVideo();
  const ruta = join(CARPETA_DE_PARCHES, parche!);
  const yaAplicado = git('apply', '--check', '--reverse', ruta).status === 0;
  if (yaAplicado) return;
  const seAplica = git('apply', '--check', ruta);
  assert.equal(seAplica.status, 0, `el parche no se aplica limpio: ${seAplica.stderr}`);
});

