/**
 * Lo único que este fichero añade a `app.json`: el fichero de Firebase que hace
 * falta para el push en Android, SI ESTÁ.
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

module.exports = ({ config }) => {
  const fichero = ficheroDeFirebase();
  if (!fichero) return config;
  return { ...config, android: { ...config.android, googleServicesFile: fichero } };
};

module.exports.ficheroDeFirebase = ficheroDeFirebase;
