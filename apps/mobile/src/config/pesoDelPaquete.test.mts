import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
  LO QUE NO TIENE QUE VOLVER A ENTRAR EN EL PAQUETE (medido el 27/10/2026).

  Metro no descarta nada por no usarse: si un fichero hace `require` de algo,
  eso viaja en el APK y en la web aunque nadie lo llegue a pintar. Tres casos
  que ya se pagaron:

  - `import { Feather } from '@expo/vector-icons'` arrastra las 19 familias de
    iconos con sus fuentes (2,71 MB de TTF que no se usan) para pintar dos.
  - `from '@expo-google-fonts/inter'` arrastra los 18 pesos de Inter (4,15 MB)
    para cargar seis.
  - `require('react-native-purchases')` fuera de un fichero `.native.ts` mete
    el SDK de RevenueCat en la web (1,02 MB), que cobra con Stripe.

  Y la caché de la web: Vercel guarda un año lo que hay bajo `/_expo/static/` y
  `/assets/`. Eso solo es correcto porque cada fichero de ahí lleva el hash de
  su contenido en el nombre.
*/

const MOVIL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const RAIZ = join(MOVIL, '..', '..');

/** El código de la aplicación, sin las pruebas. */
const codigo = globSync('{src,app}/**/*.{ts,tsx}', { cwd: MOVIL })
  .sort()
  .map((ruta) => ({ ruta, texto: readFileSync(join(MOVIL, ruta), 'utf8') }));

function quienes(patron: RegExp) {
  return codigo.filter(({ texto }) => patron.test(texto)).map(({ ruta }) => ruta);
}

describe('lo que no entra en el paquete', () => {
  it('se lee el código de verdad', () => {
    // Si el patrón dejara de casar, las demás pasarían sin mirar nada.
    assert.ok(codigo.length > 300, `solo ${codigo.length} ficheros`);
  });

  it('los iconos se importan familia a familia, nunca desde el índice', () => {
    assert.deepEqual(quienes(/from ['"]@expo\/vector-icons['"]/), []);
  });

  it('las fuentes de Inter se importan peso a peso, nunca desde el índice', () => {
    assert.deepEqual(quienes(/from ['"]@expo-google-fonts\/inter['"]/), []);
  });

  it('el SDK de RevenueCat solo se carga desde un fichero que no llega a la web', () => {
    assert.deepEqual(quienes(/['"]react-native-purchases['"]/), ['src/services/sdkDeCompras.native.ts']);
  });

  it('la versión de web del cargador no carga nada', () => {
    const web = readFileSync(join(MOVIL, 'src/services/sdkDeCompras.ts'), 'utf8');
    assert.doesNotMatch(web, /require\(/);
  });
});

describe('la caché de la web en Vercel', () => {
  type Regla = { source: string; headers: { key: string; value: string }[] };
  const vercel = JSON.parse(readFileSync(join(RAIZ, 'vercel.json'), 'utf8')) as {
    headers?: Regla[];
  };
  const inmutables = (vercel.headers ?? [])
    .filter((r) => r.headers.some((h) => /cache-control/i.test(h.key) && /immutable/.test(h.value)))
    .map((r) => r.source);

  it('lo que lleva hash en el nombre se guarda un año', () => {
    assert.deepEqual(inmutables.sort(), ['/_expo/static/(.*)', '/assets/(.*)']);
  });

  it('index.html y las páginas legales NO: tienen que verse al día en cuanto se publica', () => {
    for (const fuente of inmutables) {
      assert.ok(fuente !== '/(.*)' && !fuente.includes('.html'), `regla demasiado amplia: ${fuente}`);
    }
  });

  it('public/ no tiene carpetas que caigan bajo esas reglas sin hash en el nombre', () => {
    // Lo que hay en `public/` se publica tal cual, sin hash: una imagen en
    // `public/assets/` quedaría guardada un año aunque se cambiara.
    assert.equal(existsSync(join(MOVIL, 'public', 'assets')), false);
    assert.equal(existsSync(join(MOVIL, 'public', '_expo')), false);
  });
});
