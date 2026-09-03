import { useCallback } from 'react';
import { useRouter } from 'expo-router';

import { traduceEnElIdiomaActual, type TranslationKey } from '@/i18n';
import { confirm } from '@/lib/confirm';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Exige tener cuenta para ejecutar una acción, y solo entonces.
 *
 * La aplicación se puede recorrer entera sin registrarse: se ve el muro, los
 * perfiles, los cursos. La cuenta se pide en el momento en que la acción la
 * necesita de verdad —publicar, comentar, reaccionar, guardar—, porque son
 * cosas que quedan asociadas a alguien.
 *
 * Pedirla antes, como se hacía, obligaba a rellenar un formulario para poder
 * ver de qué iba la aplicación.
 *
 * Uso:
 *
 *   const requireAuth = useRequireAuth();
 *   onPress={() => requireAuth('para dar me gusta', () => toggleLike(id))}
 *
 * Si hay sesión, la acción se ejecuta sin más. Si no, se ofrece entrar y, al
 * aceptar, se lleva a la pantalla de acceso.
 */
/**
 * Si esta persona tendría que crear cuenta para escribir algo.
 *
 * Sale del MISMO sitio que `useRequireAuth` a propósito. La regla tiene una
 * excepción —en modo demo, sin backend, no hay sesión que exigir— y escribirla
 * dos veces es cómo una pantalla acaba bloqueando lo que la otra permite.
 *
 * Sirve para APAGAR un control antes de que lo toquen, no para sustituir a
 * `useRequireAuth`: quien pulse igual tiene que seguir encontrándose el aviso.
 */
export function useHaceFaltaCuenta(): boolean {
  const status = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  return supabaseEnabled && status !== 'authenticated';
}

export function useRequireAuth() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  return useCallback(
    async (motivo: TranslationKey, accion: () => void | Promise<void>): Promise<void> => {
      // En modo demo (sin backend) no hay sesión que exigir: la aplicación
      // funciona con datos locales y bloquear aquí la dejaría inservible.
      if (!supabaseEnabled || status === 'authenticated') {
        await accion();
        return;
      }

      const entrar = await confirm({
        title: traduceEnElIdiomaActual('auth.signUpTitle'),
        message: traduceEnElIdiomaActual('auth.needAccount', {
          motivo: traduceEnElIdiomaActual(motivo),
        }),
        confirmLabel: traduceEnElIdiomaActual('language.continue'),
        cancelLabel: traduceEnElIdiomaActual('common.notNow'),
      });
      if (entrar) router.push('/register' as never);
    },
    [router, status, supabaseEnabled],
  );
}
