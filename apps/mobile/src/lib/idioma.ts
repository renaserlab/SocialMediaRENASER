import type { Language } from '@/i18n';

/**
 * Idioma y ELECCION de idioma, que no son lo mismo.
 *
 * LA DISTINCION QUE FALTABA. La aplicacion se pinta en español mientras nadie
 * diga otra cosa, y hasta ahora eso se guardaba en el mismo sitio que la
 * decision de la persona: un `language: 'es'` que valia a la vez para «todavia
 * no ha elegido» y para «eligio español». Como no se podian distinguir, hacia
 * falta una segunda variable suelta (`languageSelected`) para saber cual de las
 * dos cosas era; y en cuanto esa variable se perdia —una instalacion venida de
 * una version anterior, un reinicio de la demo, un guardado a medias— la
 * aplicacion volvia a preguntar el idioma a alguien que ya lo habia elegido.
 *
 * Aqui la eleccion es UN solo dato y se representa por lo que es:
 *
 *   `null`  -> nadie ha elegido todavia. Hay que preguntar.
 *   'es'|'en'|'pt' -> lo eligio una persona. No se vuelve a preguntar.
 *
 * El idioma por defecto deja de ser un valor guardado y pasa a ser lo que se
 * usa MIENTRAS no hay eleccion: no puede confundirse con una respuesta porque
 * ya no se escribe en ningun sitio.
 */
export const IDIOMA_POR_DEFECTO: Language = 'es';

/** `null` = sin elegir. Es lo que se persiste. */
export type IdiomaElegido = Language | null;

const IDIOMAS: readonly Language[] = ['es', 'en', 'pt'];

export function esIdiomaConocido(valor: unknown): valor is Language {
  return typeof valor === 'string' && (IDIOMAS as readonly string[]).includes(valor);
}

/** La pantalla de idioma solo se ofrece sola cuando esto es cierto. */
export function hayQueElegirIdioma(elegido: IdiomaElegido): boolean {
  return elegido === null;
}

/** Con que idioma se pinta ahora mismo, se haya elegido o no. */
export function idiomaEfectivo(elegido: IdiomaElegido): Language {
  return elegido ?? IDIOMA_POR_DEFECTO;
}

/**
 * Traduce lo guardado por las versiones anteriores.
 *
 * Antes eran dos campos: `language` (con 'es' de valor inicial) y
 * `languageSelected`. Solo el segundo decia si hubo eleccion, asi que:
 *
 *   - `languageSelected` cierto  -> se respeta `language` como eleccion.
 *   - falso o ausente            -> nadie eligio: `null`, y se preguntara.
 *
 * Un `language` con un valor que ya no existe se trata como si no hubiera
 * eleccion: es preferible preguntar una vez a dejar la aplicacion pintada en un
 * idioma inexistente.
 */
export function migraIdiomaGuardado(guardado: {
  language?: unknown;
  languageSelected?: unknown;
}): IdiomaElegido {
  if (guardado.languageSelected !== true) return null;
  return esIdiomaConocido(guardado.language) ? guardado.language : null;
}
