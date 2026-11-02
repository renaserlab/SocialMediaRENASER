/**
 * Dónde se pinta el rótulo del directo EN ESTE TELÉFONO, y qué hace el dedo.
 *
 * LO APROBADO (02/11/2026, «Rótulo del directo»). El host —o la
 * administración— arrastra el texto a cualquier sitio de la ZONA LIBRE, lo
 * pellizca para cambiarle el tamaño y lo gira con dos dedos. Al acercarse al
 * centro se engancha (imán) y el teléfono da un toque. Arriba aparece una
 * papelera: soltarlo encima lo quita. La sala lo ve deslizarse a su sitio
 * cuando el host SUELTA, nunca mientras arrastra.
 *
 * LA ZONA LIBRE se mide en cada teléfono: del borde inferior de la cabecera
 * (+4) al borde superior del chat (−8). El texto nunca tapa la cabecera, el
 * chat ni las reacciones, midan lo que midan. La guía VERTICAL del imán es el
 * centro de la pantalla; la HORIZONTAL, el centro de la zona (el de la
 * pantalla cae casi encima del chat).
 *
 * LA POSICIÓN VIAJA EN FRACCIONES de la pantalla útil (el lienzo: lo que hay
 * dentro de las zonas seguras) y es la del CENTRO del texto. Cada teléfono la
 * encaja en su zona: en uno más bajo la zona es más corta y el texto se queda
 * dentro igual.
 *
 * Aquí está todo lo que se decide con números: sin React, sin red y sin
 * importaciones, para probarlo con el runner de Node
 * (`rotuloEnPantalla.test.mts`). Lo que se dibuja está en
 * `components/live/CapaDelRotulo.tsx`.
 */

export type Punto = { x: number; y: number };
export type Medida = { ancho: number; alto: number };
/** Un rectángulo en puntos del lienzo. */
export type Caja = { x: number; y: number; ancho: number; alto: number };
/** Por dónde puede ir el CENTRO del texto… menos lo que mide el propio texto. */
export type Zona = { izquierda: number; derecha: number; arriba: number; abajo: number };

/** Lo que la zona se separa de la cabecera (el `marginTop` del rótulo de antes). */
export const MARGEN_BAJO_LA_CABECERA = 4;
/** Lo que la zona se separa del chat. */
export const MARGEN_SOBRE_EL_CHAT = 8;
/** A cuántos puntos del centro se engancha. */
export const IMAN_PX = 8;
/** A cuántos grados de recto se endereza. */
export const IMAN_GRADOS = 5;
/** Hasta dónde llega la papelera, desde su centro. */
export const RADIO_DE_LA_PAPELERA = 46;
/** Lo que tarda el texto en deslizarse a su sitio en la pantalla de la sala. */
export const DURACION_DEL_DESLIZ_MS = 250;
/** Lo que se mueve el dedo antes de que un toque pase a ser un arrastre. */
export const UMBRAL_DE_ARRASTRE = 5;
/** Lo que el texto que sube por la hoja se queda separado de ella. */
export const MARGEN_SOBRE_LA_HOJA = 12;
/** Lo más arriba que sube el texto mientras se edita: no se mete en la barra de estado. */
export const TECHO_AL_SUBIR = 32;
/** Con cuántos decimales viaja la posición: los mismos que guarda el servidor. */
export const DECIMALES_DE_POSICION = 4;

/**
 * La zona libre de este teléfono.
 *
 * `cabecera` es la caja de la fila de arriba (de su `x` sale también el ancho
 * útil: el mismo margen que la cabecera); `bordeDelChat`, dónde empieza el
 * chat —con el mensaje fijado, si lo hay—.
 */
export function zonaLibre(medidas: { cabecera: Caja; bordeDelChat: number }): Zona {
  const { cabecera, bordeDelChat } = medidas;
  return {
    izquierda: cabecera.x,
    derecha: cabecera.x + cabecera.ancho,
    arriba: cabecera.y + cabecera.alto + MARGEN_BAJO_LA_CABECERA,
    abajo: bordeDelChat - MARGEN_SOBRE_EL_CHAT,
  };
}

/** El centro de la zona. Es donde va la guía horizontal. */
export function centroDeLaZona(zona: Zona): Punto {
  return { x: (zona.izquierda + zona.derecha) / 2, y: (zona.arriba + zona.abajo) / 2 };
}

/** Medio ancho y medio alto de la caja que ocupa el texto GIRADO. */
export function mitadesGiradas(medida: Medida, giro: number): { mx: number; my: number } {
  const a = (giro * Math.PI) / 180;
  const co = Math.abs(Math.cos(a));
  const si = Math.abs(Math.sin(a));
  return {
    mx: (medida.ancho * co + medida.alto * si) / 2,
    my: (medida.ancho * si + medida.alto * co) / 2,
  };
}

function entre(valor: number, minimo: number, maximo: number): number {
  return Math.min(Math.max(valor, minimo), maximo);
}

/**
 * Mete el centro del texto en la zona, con el texto ENTERO dentro.
 *
 * Si el texto es más grande que la zona en un sentido, se centra en ese
 * sentido: no hay sitio bueno, y el centro es el que menos tapa por cada lado.
 */
export function limitar(centro: Punto, medida: Medida, giro: number, zona: Zona): Punto {
  const { mx, my } = mitadesGiradas(medida, giro);
  const x =
    zona.izquierda + mx > zona.derecha - mx
      ? (zona.izquierda + zona.derecha) / 2
      : entre(centro.x, zona.izquierda + mx, zona.derecha - mx);
  const y =
    zona.arriba + my > zona.abajo - my
      ? (zona.arriba + zona.abajo) / 2
      : entre(centro.y, zona.arriba + my, zona.abajo - my);
  return { x, y };
}

/**
 * Dónde va el centro según la presentación guardada.
 *
 * Sin posición —un rótulo de antes, o uno nuevo— va donde iba siempre: debajo
 * de la cabecera y centrado. Para eso basta pedir la `y` del borde de arriba
 * de la zona: `limitar` lo baja lo justo para que quepa entero.
 */
export function colocar(
  posicion: { x: number | null; y: number | null },
  lienzo: Medida,
  zona: Zona,
  medida: Medida,
  giro: number,
): Punto {
  const deSiempre = posicion.x === null || posicion.y === null;
  const deseado = deSiempre
    ? { x: lienzo.ancho / 2, y: zona.arriba }
    : { x: (posicion.x as number) * lienzo.ancho, y: (posicion.y as number) * lienzo.alto };
  return limitar(deseado, medida, giro, zona);
}

/**
 * El imán al centro: si el centro del texto queda a menos de `IMAN_PX` de una
 * guía, se pega a ella. Solo si ahí cabe entero: un imán que lo saca de la zona
 * no ayuda.
 */
export function iman(
  centro: Punto,
  medida: Medida,
  giro: number,
  zona: Zona,
  lienzo: Medida,
): { centro: Punto; vertical: boolean; horizontal: boolean } {
  const guiaX = lienzo.ancho / 2;
  const guiaY = centroDeLaZona(zona).y;
  let { x, y } = centro;
  let vertical = false;
  let horizontal = false;
  if (Math.abs(x - guiaX) < IMAN_PX && limitar({ x: guiaX, y }, medida, giro, zona).x === guiaX) {
    x = guiaX;
    vertical = true;
  }
  if (Math.abs(y - guiaY) < IMAN_PX && limitar({ x, y: guiaY }, medida, giro, zona).y === guiaY) {
    y = guiaY;
    horizontal = true;
  }
  return { centro: { x, y }, vertical, horizontal };
}

/** El tamaño que se guarda: de cinco en cinco, entre el mínimo y el máximo. */
export function ajustarTamano(tamano: number, minimo = 70, maximo = 240, paso = 5): number {
  if (!Number.isFinite(tamano)) return 100;
  return entre(Math.round(tamano / paso) * paso, minimo, maximo);
}

/**
 * El giro que se guarda: grados enteros entre -180 y 180, y RECTO si queda a
 * menos de `IMAN_GRADOS` de serlo. `iman` dice si se ha enderezado, para el
 * toque en la mano.
 */
export function ajustarGiro(giro: number): { giro: number; iman: boolean } {
  if (!Number.isFinite(giro)) return { giro: 0, iman: true };
  let g = giro - 360 * Math.round(giro / 360);
  if (Math.abs(g) < IMAN_GRADOS) return { giro: 0, iman: true };
  g = Math.round(g);
  // -180 y 180 son el mismo giro; la base admite los dos.
  return { giro: entre(g, -180, 180), iman: false };
}

/** El giro que deja un paso de la hoja (−/+): sin imán, y sin pasarse de media vuelta. */
export function pasoDeGiro(giro: number, paso: number): number {
  return entre(Math.round(giro + paso), -180, 180);
}

function redondear(valor: number): number {
  const factor = 10 ** DECIMALES_DE_POSICION;
  return Math.round(valor * factor) / factor;
}

/** El centro en fracciones del lienzo: lo que se manda al servidor. */
export function aFracciones(centro: Punto, lienzo: Medida): Punto {
  if (lienzo.ancho <= 0 || lienzo.alto <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: redondear(entre(centro.x / lienzo.ancho, 0, 1)),
    y: redondear(entre(centro.y / lienzo.alto, 0, 1)),
  };
}

/** Dónde está la papelera: arriba, en el centro, a la altura de la cabecera. */
export function papeleraEn(lienzo: Medida, cabecera: Caja): Punto {
  return { x: lienzo.ancho / 2, y: cabecera.y + cabecera.alto / 2 };
}

/** Si el DEDO está encima de la papelera. Es el dedo, no el texto: el texto no sale de la zona. */
export function enLaPapelera(dedo: Punto, papelera: Punto, radio = RADIO_DE_LA_PAPELERA): boolean {
  return Math.hypot(dedo.x - papelera.x, dedo.y - papelera.y) < radio;
}

/**
 * Dónde puso el dedo, respecto al centro del texto, en puntos del lienzo.
 *
 * `local` es el toque medido dentro del texto (sin girar); se gira con él.
 * Sirve para seguir al DEDO —y no al centro del texto— hasta la papelera:
 * quien agarra un texto largo por una punta tiene que poder tirarlo igual.
 */
export function desfaseDelDedo(local: Punto, medida: Medida, giro: number): Punto {
  const dx = local.x - medida.ancho / 2;
  const dy = local.y - medida.alto / 2;
  const a = (giro * Math.PI) / 180;
  return {
    x: dx * Math.cos(a) - dy * Math.sin(a),
    y: dx * Math.sin(a) + dy * Math.cos(a),
  };
}

/**
 * Dónde está el dedo en el lienzo al empezar a arrastrar. De aquí sale si
 * está sobre la papelera.
 *
 * LAS DOS PLATAFORMAS DAN EL TOQUE DISTINTO, y por eso hay dos cuentas:
 *
 *   · En iOS y Android, `toqueLocal` llega en las coordenadas PROPIAS de la
 *     vista que se arrastra (el texto con su aire táctil, que mide `caja`),
 *     sin girar: el dedo es el centro más ese desfase girado con el texto.
 *   · En la web esa coordenada no sirve con el texto girado: gesture-handler
 *     la divide por la «escala» que lee de la matriz de la transformación, y
 *     en una matriz de giro ese número es el coseno del ángulo (a 40° la
 *     estira un 30 %; a 90° la hace infinita). Allí se usa el toque ABSOLUTO
 *     de la ventana menos dónde empieza la capa en la ventana, que no depende
 *     del giro.
 *
 * Con la cuenta del teléfono en la web, un texto girado calculaba el dedo
 * lejos de donde estaba y la papelera no se encendía (E2E del 02/11/2026).
 * Recto, las dos cuentas dan lo mismo.
 */
export function dedoAlEmpezar(datos: {
  web: boolean;
  centro: Punto;
  caja: Medida;
  giro: number;
  toqueLocal: Punto;
  toqueAbsoluto: Punto;
  origenDeLaCapa: Punto | null;
}): Punto {
  if (datos.web && datos.origenDeLaCapa) {
    return {
      x: datos.toqueAbsoluto.x - datos.origenDeLaCapa.x,
      y: datos.toqueAbsoluto.y - datos.origenDeLaCapa.y,
    };
  }
  const desfase = desfaseDelDedo(datos.toqueLocal, datos.caja, datos.giro);
  return { x: datos.centro.x + desfase.x, y: datos.centro.y + desfase.y };
}

/**
 * Cuánto sube el texto mientras se edita para que la hoja no lo tape.
 *
 * Lo justo para que su borde de abajo quede `MARGEN_SOBRE_LA_HOJA` por encima
 * de la hoja, y nunca tanto que su borde de arriba pase de `TECHO_AL_SUBIR`:
 * con la hoja muy alta, prefiere quedarse a medias que meterse bajo la barra
 * de estado.
 */
export function cuantoSube(datos: {
  centroY: number;
  medida: Medida;
  giro: number;
  techoDeLaHoja: number;
}): number {
  const { my } = mitadesGiradas(datos.medida, datos.giro);
  const falta = datos.centroY + my - (datos.techoDeLaHoja - MARGEN_SOBRE_LA_HOJA);
  const cabe = datos.centroY - my - TECHO_AL_SUBIR;
  return Math.max(0, Math.min(falta, cabe));
}

/** Lo que mide la píldora del rótulo a un tamaño dado. Al 100 %, la de antes. */
export function medidasDeLaPildora(tamano: number): {
  letra: number;
  linea: number;
  rellenoHorizontal: number;
  rellenoVertical: number;
  altoMinimo: number;
  separacion: number;
  icono: number;
} {
  const f = tamano / 100;
  return {
    letra: 13 * f,
    linea: 18.2 * f,
    rellenoHorizontal: 12 * f,
    rellenoVertical: 7 * f,
    altoMinimo: 34 * f,
    separacion: 4 * f,
    icono: 14 * f,
  };
}

/**
 * Cuánto sitio le queda al texto dentro de una píldora de `anchoMaximo`: lo
 * que mide la píldora menos los rellenos, el icono, la separación y el borde.
 * La cinta corre solo si el texto entero no cabe aquí.
 */
export function huecoParaElTexto(anchoMaximo: number, tamano: number): number {
  const m = medidasDeLaPildora(tamano);
  return Math.max(0, anchoMaximo - 2 * m.rellenoHorizontal - m.icono - m.separacion - 2);
}

export type Disposicion = { x: number | null; y: number | null; tamano: number; giro: number };

/**
 * Qué ve la sala cuando cambia el rótulo.
 *
 *   · `entra`    — es OTRO rótulo (otro texto, otro movimiento, otra fecha):
 *                  se anima su entrada.
 *   · `desliza`  — el mismo, en otro sitio, tamaño o giro: va a su sitio en
 *                  `DURACION_DEL_DESLIZ_MS` (o salta, con «reducir movimiento»).
 *   · `nada`     — el mismo y en el mismo sitio (puede haber cambiado de color:
 *                  eso se pinta sin moverse).
 */
export function comoCambia(
  antes: { clave: string; disposicion: Disposicion } | null,
  ahora: { clave: string; disposicion: Disposicion },
): 'entra' | 'desliza' | 'nada' {
  if (!antes || antes.clave !== ahora.clave) return 'entra';
  const a = antes.disposicion;
  const b = ahora.disposicion;
  return a.x !== b.x || a.y !== b.y || a.tamano !== b.tamano || a.giro !== b.giro
    ? 'desliza'
    : 'nada';
}
