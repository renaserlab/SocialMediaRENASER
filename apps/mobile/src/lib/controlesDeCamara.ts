/**
 * Donde se colocan los controles de la camara, contando desde el borde de abajo.
 *
 * POR QUE ESTO ES UN MODULO APARTE, Y SIN IMPORTAR NADA. Es la misma razon que
 * `estadoDePermiso.ts`: es la unica parte con REGLAS —el resto es pintar—, y
 * asi se puede probar. Y hacia falta probarlo, porque el fallo que arregla no
 * se ve leyendo el codigo ni probando en un emulador sin gesto de inicio:
 *
 * El disparador estaba clavado a 58 px del borde inferior, y abajo habia una
 * barra flotante que ocupa de 78 a 104 px segun el telefono. Resultado: casi
 * dos tercios del disparador quedaban tapados por la barra, y el dedo que iba a
 * hacer una foto pulsaba en realidad un boton de la barra. La pista de ayuda, a
 * 24 px, estaba entera por detras.
 *
 * LO QUE HAY ABAJO AHORA. En Crear la barra de secciones se retira y en su sitio
 * va la de los tipos de publicacion (Publicacion · Historia · Reel · Vivo), que
 * es la capa de mas abajo de esta pila. Antes esa fila iba ENCIMA del
 * disparador, como texto suelto sobre la imagen; ahora es una barra con fondo
 * propio y todo lo demas se apoya en ella.
 *
 * Con numeros sueltos escritos a mano esto vuelve a pasar en cuanto alguien
 * cambie el alto de la barra. Aqui se derivan todos de una sola medida —lo que
 * hay que dejar libre abajo— y la prueba comprueba lo unico que de verdad
 * importa: que nada quede por debajo de ese margen y que las capas no se pisen.
 */

/** Separacion entre capas. Es `spacing.sm` de los tokens. */
const AIRE = 8;

/**
 * Alto de la barra de tipos de publicacion.
 *
 * La barra de secciones mide 62: esta es mas alta a proposito —y mas ancha, ver
 * `SelectorDeModo`— para que no se confundan aunque sean de la misma familia.
 */
export const ALTO_SELECTOR = 68;

/**
 * Alto de la franja de la pista («Toca para una foto · …»).
 *
 * Caben DOS lineas. La frase no entra en una sola en casi ningun telefono: con
 * 18 px de alto y sin margenes a los lados se salia de la pantalla por los dos
 * extremos y se leia «oca para una foto · … para acerca».
 */
export const ALTO_PISTA = 52;

/** Diametro del anillo del disparador. */
export const ANILLO = 76;

export type AlturasDeCamara = {
  /** Barra de tipos de publicacion: lo de mas abajo, donde iba la de secciones. */
  selector: number;
  /** Franja de la linea de ayuda, justo encima de la barra. */
  pista: number;
  /** Fila de galeria, disparador y girar camara. */
  controles: number;
  /** Nivel de zoom, solo visible mientras se graba. */
  zoom: number;
};

/**
 * Apila las capas de abajo arriba a partir del margen que hay que dejar libre.
 *
 * `margenInferior` es lo que devuelve `useEspacioInferior()`: se pasa como
 * argumento en vez de calcularlo aqui para que este modulo no tenga que
 * importar nada —ni, con ello, React Native entero— y siga siendo probable.
 */
export function alturasDeCamara(margenInferior: number): AlturasDeCamara {
  // Nunca por debajo de cero: en la web y en un aparato sin zona segura la
  // medida puede llegar pequena, pero jamas debe empujar nada fuera de pantalla.
  const base = Math.max(0, margenInferior);

  const selector = base;
  const pista = selector + ALTO_SELECTOR + AIRE;
  const controles = pista + ALTO_PISTA + AIRE;
  const zoom = controles + ANILLO + AIRE;

  return { selector, pista, controles, zoom };
}

/**
 * Tope del zoom en iOS, contado desde el lente normal (1x).
 *
 * Lo fija el parche de `patches/expo-camera+17.0.10.patch`: sin el, el zoom 0
 * del iPhone era el ultra gran angular (0.5x, la imagen abombada) y el 1 era el
 * zoom digital maximo del sensor, decenas de aumentos de pura pixelacion.
 */
export const ZOOM_MAXIMO_IOS = 10;

/**
 * Lo que se lee en la pastilla del zoom, para un `zoom` de la camara (0 a 1).
 *
 * En iOS el parche reparte el zoom en curva (1x → 10x), como la camara del
 * sistema, asi que el numero tiene que seguir esa misma curva o mentiria. En
 * Android la libreria no expone el tope del sensor y se conserva la escala de
 * siempre.
 */
export function nivelDeZoom(zoom: number, plataforma: string): number {
  const z = Math.min(1, Math.max(0, zoom));
  return plataforma === 'ios' ? Math.pow(ZOOM_MAXIMO_IOS, z) : 1 + z * 4;
}
