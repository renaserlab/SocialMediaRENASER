import { es } from './es';
import { en } from './en';
import { pt } from './pt';

export type Language = 'es' | 'en' | 'pt';

/** Claves disponibles: las define el español, que es el idioma de referencia. */
export type TranslationKey = keyof typeof es;

const DICTIONARIES: Record<Language, Partial<Record<TranslationKey, string>>> = {
  es,
  en,
  pt,
};

export const LANGUAGE_NAMES: Record<Language, string> = {
  es: 'Castellano',
  en: 'English',
  pt: 'Português',
};

/**
 * Traduce una clave al idioma pedido.
 *
 * Si falta la traducción se devuelve el español en lugar de la clave cruda:
 * es preferible ver el texto en otro idioma a ver `profile.followers` en
 * pantalla. Así se pueden ir completando los diccionarios poco a poco.
 */
export function translate(lang: Language, key: TranslationKey): string {
  return DICTIONARIES[lang]?.[key] ?? es[key] ?? key;
}

/**
 * El idioma con el que se está pintando ahora mismo.
 *
 * Existe para lo que NO es un componente y aun así produce texto que se ve: los
 * mapeadores, que convierten la respuesta del servidor en lo que se pinta (por
 * ejemplo la fecha de un evento, «17 AGO 2026 · 13:00»). Ahí no se puede usar
 * `useTranslation`, que es un hook.
 *
 * Lo mantiene al día `useTranslation` en cada render, así que vale siempre lo
 * mismo que lo que se está viendo. Dentro de un componente NO se usa esto: allí
 * hace falta el hook, que además vuelve a pintar cuando el idioma cambia.
 */
let idiomaEnUso: Language = 'es';

export function fijarIdiomaEnUso(lang: Language): void {
  idiomaEnUso = lang;
}

/**
 * Sustituye los huecos `{nombre}` de un texto.
 *
 * Es lo que permite escribir una frase con datos dentro en UNA clave. Partirla
 * en trozos y concatenarlos produce frases rotas en cuanto el idioma ordena las
 * palabras de otra forma.
 */
export function aplicaParametros(
  texto: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return texto;
  let salida = texto;
  for (const [nombre, valor] of Object.entries(params)) {
    salida = salida.replace(`{${nombre}}`, String(valor));
  }
  return salida;
}

/** Traduce fuera de React, con el idioma que se esté pintando. */
export function traduceEnElIdiomaActual(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return aplicaParametros(translate(idiomaEnUso, key), params);
}
