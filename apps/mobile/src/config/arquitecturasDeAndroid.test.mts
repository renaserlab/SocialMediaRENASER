import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
  EL APK PESABA 219 MB (1.2.3, 27/10/2026), y 82,5 MB eran código nativo para
  `x86` y `x86_64`, procesadores que solo tienen los emuladores. Lo que se fija
  aquí:

  - que los binarios que van a teléfonos (`preview`, `production`) lleven solo
    las arquitecturas de teléfono;
  - que `development` y cualquier compilación fuera de EAS sigan como estaban,
    porque el emulador de desarrollo es `x86_64`;
  - que el recorte no pise nada de lo que ya decía `expo-build-properties`.

  Que el APK resultante arranque solo se comprueba instalándolo en un teléfono.
*/

const MOVIL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const requerir = createRequire(import.meta.url);
const configurar = requerir(join(MOVIL, 'app.config.js')) as {
  (entrada: { config: Record<string, unknown> }): Record<string, unknown>;
  arquitecturasDeAndroid: (entorno?: Record<string, string | undefined>) => string[] | null;
};

type Plugin = string | [string, Record<string, unknown>];
const app = JSON.parse(readFileSync(join(MOVIL, 'app.json'), 'utf8')) as {
  expo: Record<string, unknown> & { plugins: Plugin[] };
};

/** La configuración que saldría con este perfil de EAS. */
function conPerfil(perfil: string | undefined) {
  const anterior = process.env.EAS_BUILD_PROFILE;
  if (perfil === undefined) delete process.env.EAS_BUILD_PROFILE;
  else process.env.EAS_BUILD_PROFILE = perfil;
  try {
    return configurar({ config: app.expo }) as { plugins: Plugin[] };
  } finally {
    if (anterior === undefined) delete process.env.EAS_BUILD_PROFILE;
    else process.env.EAS_BUILD_PROFILE = anterior;
  }
}

function opcionesDeBuildProperties(plugins: Plugin[]) {
  const plugin = plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties');
  assert.ok(Array.isArray(plugin), 'falta expo-build-properties en los plugins');
  return plugin[1] as {
    ios?: Record<string, unknown>;
    android?: Record<string, unknown> & { buildArchs?: string[] };
  };
}

describe('qué arquitecturas lleva cada perfil', () => {
  it('preview y production: solo las de teléfono', () => {
    for (const perfil of ['preview', 'production']) {
      assert.deepEqual(configurar.arquitecturasDeAndroid({ EAS_BUILD_PROFILE: perfil }), [
        'arm64-v8a',
        'armeabi-v7a',
      ]);
    }
  });

  it('development, otro perfil o fuera de EAS: no se toca nada', () => {
    assert.equal(configurar.arquitecturasDeAndroid({ EAS_BUILD_PROFILE: 'development' }), null);
    assert.equal(configurar.arquitecturasDeAndroid({ EAS_BUILD_PROFILE: 'preview-ios-simulator' }), null);
    assert.equal(configurar.arquitecturasDeAndroid({}), null);
  });

  it('ninguna de las de teléfono falta: sin arm64-v8a no se instala en casi ninguno', () => {
    const arquitecturas = configurar.arquitecturasDeAndroid({ EAS_BUILD_PROFILE: 'production' }) ?? [];
    assert.ok(arquitecturas.includes('arm64-v8a'));
    assert.ok(arquitecturas.includes('armeabi-v7a'));
  });
});

describe('cómo queda la configuración', () => {
  it('con preview, expo-build-properties lleva buildArchs y conserva lo que tenía', () => {
    const antes = opcionesDeBuildProperties(app.expo.plugins);
    const despues = opcionesDeBuildProperties(conPerfil('preview').plugins);

    assert.deepEqual(despues.android?.buildArchs, ['arm64-v8a', 'armeabi-v7a']);
    const { buildArchs: _, ...restoDeAndroid } = despues.android ?? {};
    assert.deepEqual(restoDeAndroid, antes.android, 'se ha perdido algo de la parte de Android');
    assert.deepEqual(despues.ios, antes.ios, 'se ha tocado la parte de iOS');
    // Y no toca el objeto que recibió.
    assert.equal(antes.android?.buildArchs, undefined);
  });

  it('los demás plugins salen igual y en el mismo orden', () => {
    const despues = conPerfil('production').plugins;
    assert.equal(despues.length, app.expo.plugins.length);
    despues.forEach((plugin, i) => {
      const original = app.expo.plugins[i];
      if (Array.isArray(original) && original[0] === 'expo-build-properties') return;
      assert.equal(plugin, original, `el plugin ${i} ha cambiado`);
    });
  });

  it('sin perfil de EAS los plugins son los de app.json, tal cual', () => {
    assert.equal(conPerfil(undefined).plugins, app.expo.plugins);
    assert.equal(conPerfil('development').plugins, app.expo.plugins);
  });

  it('app.json no fija buildArchs: el emulador de desarrollo necesita x86_64', () => {
    assert.equal(opcionesDeBuildProperties(app.expo.plugins).android?.buildArchs, undefined);
  });
});
