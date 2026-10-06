/**
 * Los colores de la pantalla de RECORTE de fotos en Android.
 *
 * QUÉ PANTALLA ES. La que sale al elegir la foto de perfil o la portada, con la
 * cuadrícula y, arriba, «atrás», «girar», «voltear» y «CORTAR». No es de esta
 * aplicación: es la de `expo-image-picker`, que por dentro usa una biblioteca
 * de Android. Desde JavaScript no se puede tocar.
 *
 * LO REPORTADO (06/10/2026, con captura). En un teléfono en modo claro la
 * barra de arriba salía GRIS OSCURO con los iconos y «CORTAR» en NEGRO: «la
 * sección de ir para atrás, cortar, etc. aparece opaca» y «no aparece el botón
 * de cambiar foto». El botón estaba: negro sobre casi negro.
 *
 * LA CAUSA, leída en `expo-image-picker` 17. La pantalla usa un tema oscuro
 * (`Base.Theme.AppCompat`), cuyo fondo de ventana es gris oscuro, y la
 * biblioteca pinta la barra TRANSPARENTE (`expoCropToolbarColor` vale
 * `#00000000`). En modo claro pone los iconos en negro, contando con que
 * detrás hay blanco; lo que hay detrás es el gris del tema.
 *
 * EL ARREGLO. Esos colores son RECURSOS de Android con nombre, y los de la
 * aplicación mandan sobre los de una biblioteca. Aquí se declaran con un color
 * de barra OPACO: blanco con iconos negros en claro, negro con iconos blancos
 * en oscuro. El contraste deja de depender de lo que haya detrás.
 *
 * QUÉ NO ARREGLA. La cuadrícula del recorte es blanca y esa biblioteca no deja
 * cambiarle el color: sobre una foto clara apenas se ve. No hay recurso que la
 * gobierne; cambiarla exige sustituir la pantalla entera por una propia.
 *
 * Es configuración NATIVA: solo llega a los teléfonos con una compilación
 * nueva, y por eso sube `expo.version` (ver `perfilesDeCompilacion.test.mts`).
 */
const { AndroidConfig, withAndroidColors, withAndroidColorsNight } = require('expo/config-plugins');

/** Modo claro del teléfono: barra blanca, lo de encima en negro. */
const EN_CLARO = {
  expoCropToolbarColor: '#FFFFFF',
  expoCropToolbarIconColor: '#000000',
  expoCropToolbarActionTextColor: '#000000',
  expoCropBackButtonIconColor: '#000000',
  expoCropBackgroundColor: '#FFFFFF',
};

/** Modo oscuro del teléfono: barra negra, lo de encima en blanco. */
const EN_OSCURO = {
  expoCropToolbarColor: '#000000',
  expoCropToolbarIconColor: '#FFFFFF',
  expoCropToolbarActionTextColor: '#FFFFFF',
  expoCropBackButtonIconColor: '#FFFFFF',
  expoCropBackgroundColor: '#000000',
};

function poner(recursos, colores) {
  let resultado = recursos;
  for (const [name, value] of Object.entries(colores)) {
    resultado = AndroidConfig.Colors.assignColorValue(resultado, { name, value });
  }
  return resultado;
}

function withColoresDelRecorte(config) {
  const conClaro = withAndroidColors(config, (paso) => {
    paso.modResults = poner(paso.modResults, EN_CLARO);
    return paso;
  });
  return withAndroidColorsNight(conClaro, (paso) => {
    paso.modResults = poner(paso.modResults, EN_OSCURO);
    return paso;
  });
}

module.exports = withColoresDelRecorte;
module.exports.EN_CLARO = EN_CLARO;
module.exports.EN_OSCURO = EN_OSCURO;
