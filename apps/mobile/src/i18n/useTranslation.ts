import { useCallback } from 'react';

import { idiomaEfectivo } from '@/lib/idioma';
import { useAppStore } from '@/store/useAppStore';

import { translate, type Language, type TranslationKey } from './index';

/**
 * Traducción para las vistas.
 *
 * `t('home.circleMembers', { count: 12 })` sustituye `{count}` en el texto, así
 * las frases con datos no se parten en trozos (el orden de las palabras cambia
 * entre idiomas y concatenar produce frases rotas).
 */
export function useTranslation() {
  // El idioma con el que se pinta se DERIVA de la eleccion: mientras no la hay
  // se usa el de por defecto, sin escribirlo en ningun sitio donde pudiera
  // confundirse despues con una respuesta (ver `@/lib/idioma`).
  const language = useAppStore((state) => idiomaEfectivo(state.idiomaElegido));

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => {
      let text = translate(language, key);
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.replace(`{${name}}`, String(value));
        }
      }
      return text;
    },
    [language],
  );

  return { t, language: language as Language };
}
