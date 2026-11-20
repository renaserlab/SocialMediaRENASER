/**
 * El parche de `expo-camera` tiene que seguir casando con la version instalada.
 *
 * POR QUE EXISTE EL PARCHE. En los iPhone con gran angular (11 en adelante),
 * expo-camera 17 abre la camara trasera VIRTUAL (doble o triple) con zoom 1.0,
 * que en esa camara es el gran angular de 0.5x: las historias y los reels se
 * grababan con la imagen abombada, "con profundidad". El parche hace que el
 * zoom 0 sea el lente normal de 1x, como en Instagram.
 *
 * POR QUE ESTA PRUEBA. patch-package busca el parche por el nombre del fichero
 * (`expo-camera+<version>.patch`). Si alguien sube expo-camera sin rehacer el
 * parche, patch-package avisa, pero el arreglo se pierde en silencio en la
 * siguiente compilacion de EAS y nadie lo nota hasta tener un iPhone en la
 * mano. Aqui falla antes, en la integracion.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Raiz del repositorio: este fichero vive en `apps/mobile/src/config/`. */
const RAIZ = join(import.meta.dirname, '..', '..', '..', '..');
const leerJson = <T,>(nombre: string): T =>
  JSON.parse(readFileSync(join(RAIZ, nombre), 'utf8')) as T;

const CARPETA_DE_PARCHES = join(RAIZ, 'patches');
const parchesDeExpoCamera = (): string[] =>
  existsSync(CARPETA_DE_PARCHES)
    ? readdirSync(CARPETA_DE_PARCHES).filter((f) => /^expo-camera\+.+\.patch$/.test(f))
    : [];

test('hay exactamente un parche de expo-camera', () => {
  assert.equal(parchesDeExpoCamera().length, 1, `parches encontrados: ${parchesDeExpoCamera().join(', ')}`);
});

test('el parche es para la version de expo-camera que fija el package-lock', () => {
  const bloqueo = leerJson<{ packages: Record<string, { version?: string }> }>('package-lock.json');
  const instalada = bloqueo.packages['node_modules/expo-camera']?.version;
  assert.ok(instalada, 'expo-camera no aparece en node_modules/ del package-lock raiz');

  const [parche] = parchesDeExpoCamera();
  const version = parche?.match(/^expo-camera\+(.+)\.patch$/)?.[1];
  assert.equal(
    version,
    instalada,
    'Se cambio la version de expo-camera: hay que rehacer el parche (ver la cabecera de esta prueba).',
  );
});

test('el parche toca la sesion de camara de iOS', () => {
  const [parche] = parchesDeExpoCamera();
  const contenido = readFileSync(join(CARPETA_DE_PARCHES, parche), 'utf8');
  assert.match(contenido, /ios\/Current\/CameraSessionManager\.swift/);
  assert.match(contenido, /virtualDeviceSwitchOverVideoZoomFactors/);
});

test('npm install aplica los parches (postinstall con patch-package)', () => {
  const paquete = leerJson<{ scripts?: Record<string, string>; devDependencies?: Record<string, string> }>(
    'package.json',
  );
  assert.equal(paquete.scripts?.postinstall, 'patch-package');
  assert.ok(paquete.devDependencies?.['patch-package'], 'patch-package tiene que estar en devDependencies');
});
