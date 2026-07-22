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
  es: 'Español',
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
