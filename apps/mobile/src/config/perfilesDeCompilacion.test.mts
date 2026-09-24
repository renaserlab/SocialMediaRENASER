/**
 * Lo que tiene que seguir siendo verdad en `eas.json` y `app.json` para que el
 * binario que se reparte (APK) o se sube a Google Play (AAB) funcione.
 *
 * LA DIRECCION DE LA API SE GRABA AL COMPILAR. `EXPO_PUBLIC_API_URL` no se lee
 * en el telefono: EAS la escribe dentro del paquete. Cuando la cuenta de AWS de
 * Ricardo se dio de baja (septiembre de 2026), todas las apps instaladas se
 * quedaron apuntando a `d33u17ka1rcaax.cloudfront.net`, un dominio que nadie
 * mas puede redirigir, y la unica salida fue compilar y repartir otra version.
 *
 * Por eso esta aqui tambien `expo-updates`: con el canal y la huella bien
 * puestos, el siguiente cambio de direccion (por ejemplo, al pasar a un dominio
 * propio) se manda a los telefonos sin volver a pasar por la tienda.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Raiz de `apps/mobile`: este fichero vive en `src/config/`. */
const RAIZ = join(import.meta.dirname, '..', '..');
const leerJson = <T,>(nombre: string): T =>
  JSON.parse(readFileSync(join(RAIZ, nombre), 'utf8')) as T;

type Perfil = { channel?: string; extends?: string; env?: Record<string, string> };
const eas = leerJson<{ build: Record<string, Perfil> }>('eas.json');
const app = leerJson<{
  expo: {
    runtimeVersion?: { policy?: string } | string;
    updates?: { url?: string };
    extra?: { eas?: { projectId?: string } };
  };
}>('app.json');

const PERFILES = ['development', 'preview', 'production'] as const;

/** La distribucion de la cuenta dada de baja: no debe volver a ningun perfil. */
const API_DE_LA_CUENTA_ANTERIOR = 'd33u17ka1rcaax.cloudfront.net';

test('los tres perfiles llevan la API por HTTPS y ninguno la de la cuenta dada de baja', () => {
  for (const perfil of PERFILES) {
    const url = eas.build[perfil]?.env?.EXPO_PUBLIC_API_URL;
    assert.ok(url, `falta EXPO_PUBLIC_API_URL en el perfil ${perfil}`);
    assert.ok(url.startsWith('https://'), `el perfil ${perfil} no usa HTTPS: ${url}`);
    assert.ok(!url.includes(API_DE_LA_CUENTA_ANTERIOR), `el perfil ${perfil} apunta a la cuenta dada de baja`);
    assert.ok(!url.endsWith('/'), `el perfil ${perfil} termina en barra y duplicaria la de cada ruta`);
  }
});

test('los tres perfiles apuntan a la MISMA API', () => {
  // El APK de pruebas y el AAB de la tienda contra APIs distintas es la forma
  // mas facil de probar una cosa y publicar otra.
  const urls = new Set(PERFILES.map((p) => eas.build[p]?.env?.EXPO_PUBLIC_API_URL));
  assert.equal(urls.size, 1, `hay perfiles con APIs distintas: ${[...urls].join(', ')}`);
});

test('cada perfil tiene su propio canal de actualizaciones', () => {
  // Sin canal, `eas update` no tiene a quien mandar la actualizacion; con el
  // mismo canal, una prueba del APK interno llegaria a los usuarios de la tienda.
  const canales = PERFILES.map((p) => eas.build[p]?.channel);
  assert.deepEqual(canales, ['development', 'preview', 'production']);
});

test('las actualizaciones van al proyecto de Expo de la app', () => {
  const proyecto = app.expo.extra?.eas?.projectId;
  assert.ok(proyecto, 'falta extra.eas.projectId en app.json');
  assert.equal(app.expo.updates?.url, `https://u.expo.dev/${proyecto}`);
});

test('la version de ejecucion sale de la huella del codigo nativo', () => {
  // Con una version fija (o `appVersion`, que aqui siempre es 1.0.0) una
  // actualizacion de JavaScript llegaria a binarios con modulos nativos
  // distintos y la app se cerraria al abrirse. La huella cambia sola cuando
  // cambia lo nativo, y entonces la actualizacion solo llega a quien la aguanta.
  assert.deepEqual(app.expo.runtimeVersion, { policy: 'fingerprint' });
});
