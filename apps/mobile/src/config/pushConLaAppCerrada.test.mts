import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
  LO REPORTADO (04/10/2026). «Las notificaciones únicamente llegan cuando están
  dentro de la aplicación; deben llegar aun así el teléfono esté con la
  pantalla apagada o estando fuera de la aplicación».

  En Android eso pasa por Firebase, y la compilación no llevaba su fichero. Lo
  que se fija aquí es el enchufe: que la configuración lo recoja cuando esté, y
  que mientras no esté no cambie NADA —un `googleServicesFile` que apunta a un
  fichero que no existe rompe la compilación—.

  Que el aviso llegue de verdad solo se comprueba con un teléfono.
*/

const MOVIL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const requerir = createRequire(import.meta.url);
const configurar = requerir(join(MOVIL, 'app.config.js')) as {
  (entrada: { config: Record<string, unknown> }): Record<string, unknown>;
  ficheroDeFirebase: (entorno?: Record<string, string | undefined>, carpeta?: string) => string | null;
};

const temporal = mkdtempSync(join(tmpdir(), 'z-firebase-'));
after(() => rmSync(temporal, { recursive: true, force: true }));

describe('el fichero de Firebase se recoge solo si está', () => {
  it('sin fichero no hay nada que añadir', () => {
    assert.equal(configurar.ficheroDeFirebase({}, temporal), null);
  });

  it('con el fichero junto a la configuración, se usa ese', () => {
    const carpeta = mkdtempSync(join(temporal, 'local-'));
    writeFileSync(join(carpeta, 'google-services.json'), '{}');
    assert.equal(configurar.ficheroDeFirebase({}, carpeta), './google-services.json');
  });

  it('la variable de EAS manda sobre el fichero local', () => {
    const carpeta = mkdtempSync(join(temporal, 'ambos-'));
    writeFileSync(join(carpeta, 'google-services.json'), '{}');
    const deEas = join(temporal, 'de-eas.json');
    writeFileSync(deEas, '{}');
    assert.equal(configurar.ficheroDeFirebase({ GOOGLE_SERVICES_JSON: deEas }, carpeta), deEas);
  });

  it('una variable que apunta a un fichero que no existe NO se usa: rompería la compilación', () => {
    const fantasma = join(temporal, 'no-existe.json');
    assert.equal(configurar.ficheroDeFirebase({ GOOGLE_SERVICES_JSON: fantasma }, temporal), null);
  });
});

describe('la configuración de la aplicación', () => {
  const DE_APP_JSON = {
    name: 'Z',
    version: '1.2.0',
    android: { package: 'com.renaser.zeta', permissions: ['CAMERA'] },
  };

  it('hoy, sin fichero en el repositorio, es exactamente la de app.json', () => {
    // Si alguien deja el fichero en el repositorio, esta prueba cambia de
    // sentido a propósito: entonces la siguiente afirma que se recoge.
    const hayFichero = configurar.ficheroDeFirebase({}, MOVIL) !== null;
    const anterior = process.env.GOOGLE_SERVICES_JSON;
    delete process.env.GOOGLE_SERVICES_JSON;
    try {
      const salida = configurar({ config: DE_APP_JSON }) as typeof DE_APP_JSON & {
        android: { googleServicesFile?: string };
      };
      if (hayFichero) {
        assert.equal(salida.android.googleServicesFile, './google-services.json');
      } else {
        assert.equal(salida, DE_APP_JSON, 'sin fichero tiene que devolver la configuración tal cual');
      }
    } finally {
      if (anterior !== undefined) process.env.GOOGLE_SERVICES_JSON = anterior;
    }
  });

  it('con fichero lo añade a Android sin perder nada de lo que había', () => {
    const deEas = join(temporal, 'servicio.json');
    writeFileSync(deEas, '{}');
    const anterior = process.env.GOOGLE_SERVICES_JSON;
    process.env.GOOGLE_SERVICES_JSON = deEas;
    try {
      const salida = configurar({ config: DE_APP_JSON }) as {
        name: string;
        version: string;
        android: { package: string; permissions: string[]; googleServicesFile: string };
      };
      assert.equal(salida.android.googleServicesFile, deEas);
      assert.equal(salida.android.package, 'com.renaser.zeta');
      assert.deepEqual(salida.android.permissions, ['CAMERA']);
      assert.equal(salida.version, '1.2.0');
      // Y no toca el objeto que recibió.
      assert.ok(!('googleServicesFile' in DE_APP_JSON.android));
    } finally {
      if (anterior === undefined) delete process.env.GOOGLE_SERVICES_JSON;
      else process.env.GOOGLE_SERVICES_JSON = anterior;
    }
  });

  it('`app.json` no fija el fichero: eso rompería la compilación mientras no exista', () => {
    const app = JSON.parse(readFileSync(join(MOVIL, 'app.json'), 'utf8')) as {
      expo: { android?: { googleServicesFile?: string; package?: string } };
    };
    assert.equal(app.expo.android?.googleServicesFile, undefined);
    // El paquete con el que hay que dar de alta la aplicación en Firebase.
    assert.equal(app.expo.android?.package, 'com.renaser.zeta');
  });
});
