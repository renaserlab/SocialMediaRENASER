/**
 * Lo único que este fichero añade a `app.json`: dos cosas que dependen de DÓNDE
 * se compila y que por eso no pueden escribirse fijas allí.
 *
 * 1. El fichero de Firebase que hace falta para el push en Android, SI ESTÁ.
 * 2. Las arquitecturas de Android, recortadas en las compilaciones que van a
 *    teléfonos.
 *
 * ## 1. Firebase
 *
 * POR QUÉ EXISTE. En Android un aviso con la aplicación cerrada llega por
 * Firebase (FCM), aunque quien lo mande sea Expo. Sin `google-services.json`
 * dentro de la compilación el teléfono no puede pedir su dirección de push:
 * los avisos solo salen con la aplicación abierta, que es lo reportado el
 * 04/10/2026. No es un fallo del código y no se arregla desde el código: hace
 * falta un proyecto de Firebase, su fichero y una compilación nueva.
 *
 * POR QUÉ NO SE ESCRIBE EN `app.json`. Porque `android.googleServicesFile`
 * apuntando a un fichero que no existe ROMPE la compilación. Aquí se añade
 * solo cuando el fichero está, de modo que:
 *
 *   - sin fichero, la configuración es exactamente la de `app.json` y todo se
 *     compila como hasta ahora (sin push con la aplicación cerrada);
 *   - con fichero, la siguiente compilación lo lleva. No hay que tocar código.
 *
 * DE DÓNDE SALE EL FICHERO, por orden:
 *   1. la variable `GOOGLE_SERVICES_JSON`, si apunta a un fichero que existe
 *      (una variable de tipo fichero en EAS);
 *   2. `google-services.json` junto a este fichero.
 *
 * `google-services.json` no es un secreto —va dentro de cada APK—. La clave
 * que SÍ lo es, la de la cuenta de servicio, no pasa por aquí: se sube a EAS
 * con `eas credentials`. Los pasos, en `docs/PUBLICAR_EN_GOOGLE_PLAY.md`.
 *
 * ## 2. Arquitecturas de Android
 *
 * POR QUÉ. Sin decir nada, el APK lleva el código nativo compilado para cuatro
 * procesadores. Medido en el APK 1.2.3 (EAS `c80d09e4`, 27/10/2026): pesaba
 * 219 MB, y 82,5 MB eran de `x86` y `x86_64`. Los teléfonos son `arm64-v8a`
 * (todos los de los últimos años) y `armeabi-v7a` (los de 32 bits que aún
 * circulan). Con el recorte, el APK 1.2.3 (67) pesa 132,6 MB y sus 62
 * librerías ARM son idénticas byte a byte a las del APK anterior.
 *
 * SOLO EN `preview`, el APK que se reparte a mano a teléfonos.
 *
 * - NO en `production`. Es un AAB y Google Play ya lo reparte partido por
 *   arquitectura: quitarle `x86_64` no ahorra nada a nadie. Y rompe los
 *   aparatos `x86_64` que ejecutan ARM traduciéndolo (Chromebooks con Intel,
 *   el emulador): Android instala la parte ARM, pero SoLoader busca las
 *   librerías en `lib/x86_64` y la aplicación se cierra al abrir
 *   («couldn't find DSO to load: libreactnative.so»). Medido en el emulador
 *   con el APK 67 el 27/10/2026.
 * - NO en `development`, por lo mismo: el emulador es `x86_64`.
 *
 * EAS pone el nombre del perfil en `EAS_BUILD_PROFILE` al compilar; sin esa
 * variable (en local, en las pruebas) no se toca nada.
 *
 * Todo lo demás sigue en `app.json`. No se añade nada más aquí.
 */
const fs = require('node:fs');
const path = require('node:path');

/** La ruta del fichero de Firebase, o `null` si no hay ninguno. */
function ficheroDeFirebase(entorno = process.env, carpeta = __dirname) {
  const deLaVariable = entorno.GOOGLE_SERVICES_JSON;
  if (deLaVariable && fs.existsSync(deLaVariable)) return deLaVariable;
  return fs.existsSync(path.join(carpeta, 'google-services.json')) ? './google-services.json' : null;
}

/** Los perfiles de EAS cuyo APK se reparte a mano a teléfonos. */
const PERFILES_PARA_TELEFONOS = ['preview'];

/** Las arquitecturas de los teléfonos Android. */
const ARQUITECTURAS_DE_TELEFONO = ['arm64-v8a', 'armeabi-v7a'];

/** Las arquitecturas que lleva esta compilación, o `null` para no tocar nada. */
function arquitecturasDeAndroid(entorno = process.env) {
  return PERFILES_PARA_TELEFONOS.includes(entorno.EAS_BUILD_PROFILE)
    ? ARQUITECTURAS_DE_TELEFONO
    : null;
}

/** Los plugins con `buildArchs` puesto en `expo-build-properties`. */
function conArquitecturas(plugins, arquitecturas) {
  return plugins.map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin;
    const [nombre, opciones = {}] = plugin;
    return [nombre, { ...opciones, android: { ...opciones.android, buildArchs: arquitecturas } }];
  });
}

module.exports = ({ config }) => {
  let salida = config;
  const fichero = ficheroDeFirebase();
  if (fichero) {
    salida = { ...salida, android: { ...salida.android, googleServicesFile: fichero } };
  }
  const arquitecturas = arquitecturasDeAndroid();
  if (arquitecturas) {
    salida = { ...salida, plugins: conArquitecturas(salida.plugins ?? [], arquitecturas) };
  }
  return salida;
};

module.exports.ficheroDeFirebase = ficheroDeFirebase;
module.exports.arquitecturasDeAndroid = arquitecturasDeAndroid;
