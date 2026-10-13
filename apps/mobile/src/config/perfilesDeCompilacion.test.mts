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
 * Por eso esta aqui tambien `expo-updates`: con el canal y la version de
 * ejecucion bien puestos, el siguiente cambio de direccion (por ejemplo, al pasar a un dominio
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
    version: string;
    runtimeVersion?: { policy?: string } | string;
    updates?: { url?: string };
    extra?: { eas?: { projectId?: string } };
    plugins: (string | [string, unknown])[];
    android: {
      permissions?: string[];
      blockedPermissions?: string[];
      edgeToEdgeEnabled?: boolean;
      predictiveBackGestureEnabled?: boolean;
    };
  };
}>('app.json');
const paquete = leerJson<{ dependencies: Record<string, string> }>('package.json');

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

test('.easignore cubre todo lo que ignora .gitignore', () => {
  // Si `.easignore` existe, EAS lo usa EN LUGAR de `.gitignore`: una linea
  // nueva en `.gitignore` que no se copie aqui (un `.env`, unos secretos, unas
  // evidencias) acabaria subida a los servidores de compilacion de Expo.
  const repo = join(RAIZ, '..', '..');
  const reglas = (fichero: string) =>
    new Set(
      readFileSync(join(repo, fichero), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    );
  const git = reglas('.gitignore');
  const eas = reglas('.easignore');
  const faltan = [...git].filter((r) => !eas.has(r));
  assert.deepEqual(faltan, [], `.easignore no copia estas reglas de .gitignore: ${faltan.join(', ')}`);
  for (const local of ['.claude/', '.github/agents/', '.github/hooks/', '.github/skills/']) {
    assert.ok(eas.has(local), `.easignore deberia excluir ${local}`);
  }
});

test('la version de ejecucion es la version de la app', () => {
  // NO la huella (`fingerprint`): el 23/09/2026 las dos primeras builds con
  // expo-updates fallaron en EAS porque la huella calculada en local y la de
  // los servidores no coincidian (174 ficheros de node_modules que Expo carga
  // al leer la configuracion, y la carpeta `android` que genera la build).
  // Con `appVersion` la version de ejecucion es `expo.version`, igual en todas
  // partes. El precio es la prueba de abajo.
  assert.deepEqual(app.expo.runtimeVersion, { policy: 'appVersion' });
});

/**
 * LO NATIVO DE CADA VERSION. Una actualizacion de `eas update` llega a TODAS
 * las builds con la misma `expo.version`. Si una build nueva trae un modulo
 * nativo que las anteriores no tienen y la version no cambia, la
 * actualizacion llega tambien a las viejas y la app se cierra al abrirse.
 *
 * Asi que: al cambiar algo de esta lista, se SUBE `expo.version` en app.json
 * y se AÑADE una entrada nueva con esa version. Las entradas existentes no se
 * editan: describen binarios que ya estan en telefonos.
 *
 * `react-native-web`, `react-native-qrcode-svg` o `react-native-url-polyfill`
 * son solo JavaScript, pero el patron los recoge: ante la duda, se sube la
 * version (tambien al cambiar opciones de un plugin que afecten a lo nativo,
 * como las de `expo-build-properties`).
 */
const NATIVO_POR_VERSION: Record<string, { dependencias: string[]; plugins: string[]; permisos: string[] }> = {
  '1.0.0': {
    dependencias: [
      '@100mslive/react-native-hms@1.12.3',
      '@react-native-async-storage/async-storage@2.2.0',
      '@react-native-community/datetimepicker@8.4.4',
      'expo-audio@~1.1.1',
      'expo-blur@~15.0.8',
      'expo-build-properties@~1.0.10',
      'expo-camera@~17.0.10',
      'expo-constants@~18.0.14',
      'expo-device@~8.0.10',
      'expo-document-picker@~14.0.8',
      'expo-file-system@~19.0.24',
      'expo-font@~14.0.12',
      'expo-haptics@~15.0.8',
      'expo-image-picker@~17.0.11',
      'expo-image@~3.0.11',
      'expo-linear-gradient@~15.0.8',
      'expo-linking@~8.0.12',
      'expo-media-library@~18.2.1',
      'expo-notifications@~0.32.17',
      'expo-router@~6.0.24',
      'expo-splash-screen@~31.0.13',
      'expo-status-bar@~3.0.9',
      'expo-updates@~29.0.20',
      'expo-video@~3.0.16',
      'expo-web-browser@~15.0.11',
      'expo@~54.0.37',
      'react-native-compressor@^1.19.4',
      'react-native-gesture-handler@~2.28.0',
      'react-native-purchases@^10.8.0',
      'react-native-qrcode-svg@^6.3.15',
      'react-native-reanimated@~4.1.1',
      'react-native-safe-area-context@~5.6.0',
      'react-native-screens@~4.16.0',
      'react-native-svg@15.12.1',
      'react-native-url-polyfill@^2.0.0',
      'react-native-web@^0.21.2',
      'react-native-worklets@0.5.1',
      'react-native@0.81.5',
    ],
    plugins: [
      'expo-router',
      'expo-splash-screen',
      'expo-audio',
      'expo-image-picker',
      'expo-camera',
      'expo-notifications',
      'expo-font',
      'expo-video',
      'react-native-compressor',
      'expo-web-browser',
      '@react-native-community/datetimepicker',
      'expo-media-library',
      'expo-build-properties',
    ],
    permisos: [
      'android.permission.CAMERA',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'android.permission.WAKE_LOCK',
      'android.permission.RECORD_AUDIO',
      '-android.permission.SYSTEM_ALERT_WINDOW',
      '-android.permission.READ_EXTERNAL_STORAGE',
      '-android.permission.WRITE_EXTERNAL_STORAGE',
    ],
  },
  // 1.1.0: los permisos que pide 100ms para emitir (audio por Bluetooth y
  // estado de red). Ademas cambiaron los textos de camara y microfono.
  '1.1.0': {
    dependencias: [
      '@100mslive/react-native-hms@1.12.3',
      '@react-native-async-storage/async-storage@2.2.0',
      '@react-native-community/datetimepicker@8.4.4',
      'expo-audio@~1.1.1',
      'expo-blur@~15.0.8',
      'expo-build-properties@~1.0.10',
      'expo-camera@~17.0.10',
      'expo-constants@~18.0.14',
      'expo-device@~8.0.10',
      'expo-document-picker@~14.0.8',
      'expo-file-system@~19.0.24',
      'expo-font@~14.0.12',
      'expo-haptics@~15.0.8',
      'expo-image-picker@~17.0.11',
      'expo-image@~3.0.11',
      'expo-linear-gradient@~15.0.8',
      'expo-linking@~8.0.12',
      'expo-media-library@~18.2.1',
      'expo-notifications@~0.32.17',
      'expo-router@~6.0.24',
      'expo-splash-screen@~31.0.13',
      'expo-status-bar@~3.0.9',
      'expo-updates@~29.0.20',
      'expo-video@~3.0.16',
      'expo-web-browser@~15.0.11',
      'expo@~54.0.37',
      'react-native-compressor@^1.19.4',
      'react-native-gesture-handler@~2.28.0',
      'react-native-purchases@^10.8.0',
      'react-native-qrcode-svg@^6.3.15',
      'react-native-reanimated@~4.1.1',
      'react-native-safe-area-context@~5.6.0',
      'react-native-screens@~4.16.0',
      'react-native-svg@15.12.1',
      'react-native-url-polyfill@^2.0.0',
      'react-native-web@^0.21.2',
      'react-native-worklets@0.5.1',
      'react-native@0.81.5',
    ],
    plugins: [
      'expo-router',
      'expo-splash-screen',
      'expo-audio',
      'expo-image-picker',
      'expo-camera',
      'expo-notifications',
      'expo-font',
      'expo-video',
      'react-native-compressor',
      'expo-web-browser',
      '@react-native-community/datetimepicker',
      'expo-media-library',
      'expo-build-properties',
    ],
    permisos: [
      'android.permission.CAMERA',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      'android.permission.WAKE_LOCK',
      'android.permission.RECORD_AUDIO',
      'android.permission.BLUETOOTH',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.CHANGE_NETWORK_STATE',
      '-android.permission.SYSTEM_ALERT_WINDOW',
      '-android.permission.READ_EXTERNAL_STORAGE',
      '-android.permission.WRITE_EXTERNAL_STORAGE',
    ],
  },
};

// 1.1.1: dependencias, plugins y permisos iguales que 1.1.0. Sube por el
// MANIFIESTO: `predictiveBackGestureEnabled` pasa a `false` (ver la prueba del
// boton Atras, abajo), que solo llega a los telefonos con un binario nuevo.
NATIVO_POR_VERSION['1.1.1'] = NATIVO_POR_VERSION['1.1.0'];

// 1.2.0: entra `@100mslive/react-native-video-plugin`, el complemento con el
// que 100ms aplica el desenfoque y el fondo virtual a la camara de quien
// emite. Trae un modulo nativo en Android (`ReactNativeVideoPlugin`); en iOS
// lo sirve el propio SDK, que ya estaba. Plugins y permisos no cambian: el
// complemento no pide ninguno. Una actualizacion sobre un binario 1.1.x no
// encontraria el modulo —la aplicacion lo detecta y no ofrece los efectos—,
// pero la version sube igualmente: es la regla, y evita depender de esa red.
NATIVO_POR_VERSION['1.2.0'] = {
  ...(NATIVO_POR_VERSION['1.1.0'] as (typeof NATIVO_POR_VERSION)[string]),
  dependencias: [
    ...(NATIVO_POR_VERSION['1.1.0'] as (typeof NATIVO_POR_VERSION)[string]).dependencias,
    '@100mslive/react-native-video-plugin@1.1.4',
  ],
};

// 1.2.1: dependencias y permisos iguales que 1.2.0. Sube por dos cosas que
// solo llegan con un binario nuevo:
//   - el plugin propio `./plugins/withColoresDelRecorte`, que declara como
//     recursos de Android los colores de la pantalla de recorte de fotos (su
//     barra salia gris oscuro con los iconos en negro);
//   - los dos tonos del chat, que el plugin `expo-notifications` empaqueta
//     dentro de la aplicacion (`sounds`). Sin ellos en el binario, un tono
//     sonaria como el aviso por defecto del telefono.
NATIVO_POR_VERSION['1.2.1'] = {
  ...(NATIVO_POR_VERSION['1.2.0'] as (typeof NATIVO_POR_VERSION)[string]),
  plugins: (() => {
    const anteriores = (NATIVO_POR_VERSION['1.2.0'] as (typeof NATIVO_POR_VERSION)[string]).plugins;
    const tras = anteriores.indexOf('expo-notifications') + 1;
    return [...anteriores.slice(0, tras), './plugins/withColoresDelRecorte', ...anteriores.slice(tras)];
  })(),
};

// 1.2.2: dependencias, plugins y permisos iguales que 1.2.1. Sube porque entra
// un tercer tono en `sounds` del plugin `expo-notifications`: el de «alguien
// está escribiendo» (`alguien_escribe.wav`). Va dentro del binario, y una
// actualización sobre uno 1.2.1 lo haría sonar como el aviso por defecto del
// teléfono cada vez que alguien teclea.
NATIVO_POR_VERSION['1.2.2'] = NATIVO_POR_VERSION['1.2.1'] as (typeof NATIVO_POR_VERSION)[string];

// 1.2.3: dependencias, plugins y permisos iguales que 1.2.2. Sube porque el
// tono de «alguien está escribiendo» es OTRO sonido con el mismo nombre: el
// de la 1.2.2 no se oía en el teléfono (salió a la mitad de volumen que los
// otros dos y con siete centésimas de sonido). El archivo va dentro del
// binario, así que solo cambia con una compilación nueva; con otro número se
// sabe cuál de los dos lleva cada teléfono.
NATIVO_POR_VERSION['1.2.3'] = NATIVO_POR_VERSION['1.2.2'] as (typeof NATIVO_POR_VERSION)[string];

// 1.2.4: dependencias, plugins y permisos iguales que 1.2.3. Sube porque el
// icono de las notificaciones es otro: la silueta de la Z, donde antes salía
// una «R». Es el archivo `assets/notification-icon.png`, que el plugin
// `expo-notifications` convierte en un recurso de Android: va dentro del
// binario y solo cambia con una compilación nueva.
NATIVO_POR_VERSION['1.2.4'] = NATIVO_POR_VERSION['1.2.3'] as (typeof NATIVO_POR_VERSION)[string];

test('si cambia algo nativo, cambia expo.version', () => {
  const version = app.expo.version;
  const esperado = NATIVO_POR_VERSION[version];
  assert.ok(
    esperado,
    `expo.version es ${version} y no tiene entrada en NATIVO_POR_VERSION: añade la lista nativa de esa version`,
  );
  const NATIVO = /^(expo($|-)|react-native($|-)|@react-native|@100mslive\/)/;
  const actual = {
    dependencias: Object.entries(paquete.dependencies)
      .filter(([nombre]) => NATIVO.test(nombre))
      .map(([nombre, rango]) => `${nombre}@${rango}`)
      .sort(),
    plugins: app.expo.plugins.map((p) => (typeof p === 'string' ? p : p[0])),
    permisos: [
      ...(app.expo.android.permissions ?? []),
      ...(app.expo.android.blockedPermissions ?? []).map((p) => `-${p}`),
    ],
  };
  assert.deepEqual(
    actual,
    { ...esperado, dependencias: [...esperado.dependencias].sort() },
    `Lo nativo cambio y expo.version sigue en ${version}. Una actualizacion llegaria a builds sin ` +
      'esos modulos. Sube expo.version en app.json y añade su entrada a NATIVO_POR_VERSION.',
  );
});

test('el boton Atras de Android le llega a la aplicacion', () => {
  /*
    CON EL GESTO PREDICTIVO ENCENDIDO, ATRAS CERRABA LA APLICACION DESDE
    CUALQUIER PANTALLA. `predictiveBackGestureEnabled: true` escribe
    `android:enableOnBackInvokedCallback="true"` en el manifiesto, y desde
    Android 13 el sistema manda entonces la pulsacion a su propio despachador.
    React Native 0.81 solo lo conecta con `BackHandler` en Android 16: en 13, 14
    y 15 la pulsacion no llega a JavaScript, Android hace lo que haria sin
    aplicacion delante —cerrarla— y ni la navegacion de expo-router ni
    `useSalidaConDoblePulsacion` («Presiona una vez más para salir de la aplicación») llegan a
    enterarse (https://github.com/expo/expo/issues/39092).

    Estuvo encendido desde la carga inicial del proyecto, y por eso arreglar la
    logica de Atras en JavaScript no cambio nada en los telefonos. Es del
    manifiesto: solo se corrige con un binario nuevo (1.1.1), no con `eas update`.
  */
  assert.equal(app.expo.android.predictiveBackGestureEnabled, false);
  // Y la razon por la que las pantallas respetan la zona segura de abajo:
  // `AppScreen` lo da por hecho (ver `bordesPorOmision`).
  assert.equal(app.expo.android.edgeToEdgeEnabled, true);
});
