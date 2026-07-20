import { create } from 'zustand';

import { AuthRepository, SignInInput, SignUpInput, SignUpResult } from '@/repositories/AuthRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { setAuthTokenProvider, ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

type AuthState = {
  status: AuthStatus;
  /** true cuando Supabase esta configurado; false = modo demo local. */
  supabaseEnabled: boolean;
  initialized: boolean;

  bootstrap: () => Promise<void>;
  signUpEmail: (input: SignUpInput) => Promise<SignUpResult>;
  signInEmail: (input: SignInInput) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

let unsubscribeAuth: (() => void) | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  supabaseEnabled: AuthRepository.enabled,
  initialized: false,

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

    const session = await AuthRepository.getSession();
    if (session) {
      await get().refreshProfile();
      set({ status: 'authenticated' });
    } else {
      set({ status: 'anonymous' });
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
    try {
      const profile = await ProfileRepository.getMyProfile();
      useAppStore.getState().setUser(profile);
    } catch (error) {
      // Si el perfil aun no existe (trigger en curso) no bloqueamos la sesion.
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
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
}));
