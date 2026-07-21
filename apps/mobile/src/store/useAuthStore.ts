import { create } from 'zustand';

import { AuthRepository, SignInInput, SignUpInput, SignUpResult } from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { setAuthTokenProvider, ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import type { UserProfile } from '@/types';

export type ProfilePatch = Partial<Pick<UserProfile, 'fullName' | 'username' | 'bio'>>;

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

type AuthState = {
  status: AuthStatus;
  /** true cuando Supabase esta configurado; false = modo demo local. */
  supabaseEnabled: boolean;
  initialized: boolean;
  /** Mensaje si fallo la carga del perfil (para mostrar reintento en la UI). */
  profileError: string | null;

  bootstrap: () => Promise<void>;
  signUpEmail: (input: SignUpInput) => Promise<SignUpResult>;
  signInEmail: (input: SignInInput) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: ProfilePatch) => Promise<void>;
};

let unsubscribeAuth: (() => void) | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  supabaseEnabled: AuthRepository.enabled,
  initialized: false,
  profileError: null,

  async bootstrap() {
    if (get().initialized) return;
    set({ initialized: true });

    if (!AuthRepository.enabled) {
      // Modo demo: sin backend real. La app sigue funcionando con datos locales.
      set({ status: 'anonymous', supabaseEnabled: false });
      return;
    }

    // Cada request al backend llevara el JWT actual de Supabase.
    setAuthTokenProvider(() => AuthRepository.getAccessToken());

    try {
      const session = await AuthRepository.getSession();
      if (session) {
        await get().refreshProfile();
        set({ status: 'authenticated' });
      } else {
        set({ status: 'anonymous' });
      }
    } catch (error) {
      // Si la sesion no se puede resolver (red caida, backend abajo) NO dejamos
      // `status` en 'loading': eso congelaba el spinner de app/index.tsx para
      // siempre. Degradamos a anonimo y liberamos el guard para poder reintentar.
      console.warn('[auth] no se pudo restaurar la sesion; se continua como anonimo', error);
      set({ status: 'anonymous', initialized: false });
      return;
    }

    // Mantiene la sesion sincronizada ante login/logout/refresh de token.
    // El trabajo async se difiere para no llamar a Supabase dentro de su
    // propio callback (evita un posible deadlock documentado en supabase-js).
    unsubscribeAuth?.();
    unsubscribeAuth = AuthRepository.onAuthStateChange((nextSession) => {
      setTimeout(() => {
        if (nextSession) {
          void get()
            .refreshProfile()
            .then(() => set({ status: 'authenticated' }))
            .catch(() => {});
        } else {
          useAppStore.getState().setUser(null);
          set({ status: 'anonymous' });
        }
      }, 0);
    });
  },

  async refreshProfile() {
    // Se reintenta porque justo despues de iniciar sesion la primera peticion
    // puede fallar de forma transitoria (token recien emitido, perfil aun
    // creandose por el trigger). Sin reintento el usuario quedaba a null y la
    // sesion se veia sin perfil hasta recargar la app entera.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const profile = await ProfileRepository.getMyProfile();
        useAppStore.getState().setUser(profile);
        set({ profileError: null });
        return;
      } catch (error) {
        const isLast = attempt === MAX_ATTEMPTS;

        // Si el perfil aun no existe (trigger en curso) no bloqueamos la sesion.
        if (error instanceof ApiError && error.status === 404 && isLast) {
          set({ profileError: null });
          return;
        }

        if (isLast) {
          set({
            profileError:
              error instanceof Error ? error.message : 'No se pudo cargar el perfil.',
          });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  },

  async signUpEmail(input) {
    const result = await AuthRepository.signUp(input);
    if (result.session) {
      await get().refreshProfile();
      set({ status: 'authenticated' });
    }
    return result;
  },

  async signInEmail(input) {
    await AuthRepository.signIn(input);
    await get().refreshProfile();
    set({ status: 'authenticated' });
  },

  async signOut() {
    await AuthRepository.signOut();
    useAppStore.getState().setUser(null);
    set({ status: 'anonymous' });
  },

  async updateProfile(patch) {
    const appStore = useAppStore.getState();

    // Modo demo: se actualiza el usuario local sin backend.
    if (!AuthRepository.enabled) {
      const current = appStore.user;
      if (current) appStore.setUser({ ...current, ...patch });
      return;
    }

    const updated = await ProfileRepository.updateMyProfile(patch);
    appStore.setUser(updated);
  },
}));
