import { useCallback } from 'react';

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
  const language = useAppStore((state) => state.language);

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
