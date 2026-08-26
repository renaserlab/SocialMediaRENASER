/**
 * Donde se colocan los controles de la camara, contando desde el borde de abajo.
 *
 * POR QUE ESTO ES UN MODULO APARTE, Y SIN IMPORTAR NADA. Es la misma razon que
 * `estadoDePermiso.ts`: es la unica parte con REGLAS —el resto es pintar—, y
 * asi se puede probar. Y hacia falta probarlo, porque el fallo que arregla no
 * se ve leyendo el codigo ni probando en un emulador sin gesto de inicio:
 *
 * El disparador estaba clavado a 58 px del borde inferior. La camara solo se
 * abre desde Crear, que vive DENTRO de las pestanas, y la barra flotante de
 * secciones se pinta POR ENCIMA de la pantalla ocupando de 42 a 104 px en un
 * telefono con gesto. Resultado: casi dos tercios del disparador quedaban
 * tapados por la barra, y el dedo que iba a hacer una foto pulsaba en realidad
 * un icono de la barra y se marchaba a otra seccion. La pista de ayuda, a 24
 * px, estaba entera por detras.
 *
 * Con tres numeros sueltos escritos a mano esto vuelve a pasar en cuanto alguien
 * cambie el alto de la barra. Aqui se derivan todos de una sola medida —lo que
 * ocupa la barra— y la prueba comprueba lo unico que de verdad importa: que
 * nada quede por debajo de ella y que las capas no se pisen entre si.
 */

/** Separacion entre capas. Es `spacing.sm` de los tokens. */
const AIRE = 8;

/** Alto de la linea de pista («Toca para una foto · …»). */
export const ALTO_PISTA = 18;

/** Diametro del anillo del disparador. */
export const ANILLO = 76;

/** Alto de la fila del selector de modo (Publicacion · Historia · Reel · Vivo). */
export const ALTO_SELECTOR = 40;

export type AlturasDeCamara = {
  /** Linea de ayuda, lo mas abajo que se puede sin meterse bajo la barra. */
  pista: number;
  /** Fila de galeria, disparador y girar camara. */
  controles: number;
  /** Selector de modo, que Crear pinta dentro de la camara. */
  selector: number;
  /** Nivel de zoom, solo visible mientras se graba. */
  zoom: number;
};

/**
 * Apila las capas de abajo arriba a partir de lo que ocupa la barra flotante.
 *
 * `espacioDeLaBarra` es lo que devuelve `espacioParaLaBarra(insets.bottom)`: se
 * pasa como argumento en vez de calcularlo aqui para que este modulo no tenga
 * que importar la barra —ni, con ella, React Native entero— y siga siendo
 * probable.
 */
export function alturasDeCamara(espacioDeLaBarra: number): AlturasDeCamara {
  // Nunca por debajo de cero: en la web y en un aparato sin zona segura la
  // medida puede llegar pequena, pero jamas debe empujar nada fuera de pantalla.
  const base = Math.max(0, espacioDeLaBarra);

  const pista = base + AIRE;
  const controles = pista + ALTO_PISTA + AIRE;
  const selector = controles + ANILLO + AIRE;
  const zoom = selector + ALTO_SELECTOR + AIRE;

  return { pista, controles, selector, zoom };
}
